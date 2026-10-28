"""Maintenance evidence, not a production release authorization."""
from copy import deepcopy
import unittest
from unittest.mock import patch

import joint_memory_backup as joint
import test_joint_memory_backup as support


class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.fixture=support.JointBackupTest(methodName='runTest');self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.paths=self.fixture.paths
        db=self.fixture.host
        db.executescript('''CREATE TABLE night_runs(status TEXT);CREATE TABLE proactive_message_jobs(status TEXT);
            CREATE TABLE image_descriptions(status TEXT);ALTER TABLE sessions ADD COLUMN title_state TEXT;''')
        self.fixture.receiver.executescript('CREATE TABLE pipeline_jobs(batch_id TEXT,output_json TEXT);CREATE TABLE pipeline_batches(id TEXT,status TEXT);')
        self.units=['synthetic-host.service','synthetic-receiver.service','synthetic-worker.timer']
        self.unit=patch.object(joint,'_unit_status',return_value={'ActiveState':'inactive','SubState':'dead','MainPID':'0','InvocationID':'synthetic'})
        self.unit.start();self.addCleanup(self.unit.stop)
        self.proc=patch.object(joint,'_open_holders',return_value=([],0));self.proc.start();self.addCleanup(self.proc.stop)

    def status(self):return joint.maintenance_status(self.paths,self.units)

    def test_stopped_declared_units_and_drained_jobs_are_auditable_not_release(self):
        state=self.status();self.assertTrue(state['ready']);self.assertFalse(state['release_certified'])
        self.assertEqual(len(state['jobs']),6)

    def test_active_unit_or_timer_blocks_snapshot_before_write(self):
        with patch.object(joint,'_unit_status',return_value={'ActiveState':'active','SubState':'running','MainPID':'100'}):
            with self.assertRaisesRegex(ValueError,'Maintenance audit blocked'):
                joint.controlled_snapshot(self.paths,{'identity':self.fixture.assets},self.fixture.destination,
                                          self.fixture.password,units=self.units)
        self.assertEqual(list(self.fixture.destination.iterdir()),[])

    def test_persistent_running_task_blocks(self):
        self.fixture.host.execute("INSERT INTO night_runs VALUES('running')");self.fixture.host.commit()
        self.assertFalse(self.status()['ready'])

    def test_unknown_queue_or_inaccessible_descriptors_block(self):
        self.fixture.receiver.execute('DROP TABLE pipeline_jobs');self.fixture.receiver.commit()
        self.assertFalse(self.status()['ready'])
        with patch.object(joint,'_open_holders',return_value=([],1)):
            self.assertIn('unreadable_process_descriptors',self.status()['blockers'])

    def test_external_database_handle_blocks(self):
        with patch.object(joint,'_open_holders',return_value=([123],0)):
            self.assertIn('external_database_handles',self.status()['blockers'])

    def test_maintenance_change_during_encryption_aborts_publish(self):
        before=self.status();after=deepcopy(before);after['units'][self.units[0]]['InvocationID']='restarted'
        with patch.object(joint,'maintenance_status',side_effect=[before,after]):
            with self.assertRaisesRegex(ValueError,'Maintenance state changed'):
                joint.controlled_snapshot(self.paths,{'identity':self.fixture.assets},self.fixture.destination,
                                          self.fixture.password,units=self.units)
        self.assertEqual(list(self.fixture.destination.iterdir()),[])

    def test_restored_snapshot_is_not_permission_to_clear_quarantine(self):
        self.fixture.add();self.fixture.deliver()
        package,_,state=joint.controlled_snapshot(self.paths,{'identity':self.fixture.assets},self.fixture.destination,
                                                self.fixture.password,units=self.units)
        target=self.fixture.root/'review';joint.restore(package,target,self.fixture.password)
        review=joint.resume_review(target,state['receiver'])
        self.assertTrue(review['ready_for_operator_review']);self.assertFalse(review['release_certified'])
        self.assertTrue(review['recall_blocked'])
        review=joint.resume_review(target,{**state['receiver'],'sequence':999})
        self.assertFalse(review['ready_for_operator_review'])

    def test_unit_inventory_cannot_be_implicit(self):
        with self.assertRaises(ValueError):joint.maintenance_status(self.paths,[])

    def test_pinned_pipeline_uses_output_and_parent_state_not_invented_status(self):
        db=self.fixture.receiver
        db.execute("INSERT INTO pipeline_batches VALUES('old','superseded_source_epoch')")
        db.execute("INSERT INTO pipeline_jobs VALUES('old',NULL)");db.commit()
        self.assertTrue(self.status()['ready'])
        db.execute("INSERT INTO pipeline_jobs VALUES('missing-parent',NULL)");db.commit()
        self.assertFalse(self.status()['ready'])


if __name__=='__main__':unittest.main()
