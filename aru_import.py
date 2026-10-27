"""Pure Aru Markdown preview/conversion. Never opens ZIPs or writes databases."""
from datetime import datetime, timezone
import hashlib
import re
from pathlib import PurePosixPath
from urllib.parse import unquote


HEADER = re.compile(r'^#{2,6}\s+(?P<speaker>.+?)\s*(?:[|｜·—–-]\s*|[（(]\s*)?'
                    r'(?P<stamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s*[)）]?\s*$')
ATTACHMENT = re.compile(r'!?\[[^\]\n]*\]\(([^)]+)\)')


def parse_markdown(raw, *, session_id, user_name='你', ai_name='谢亦言', ai_id='assistant'):
    if not session_id:
        raise ValueError('Explicit stable session identity is required')
    if isinstance(raw, str):
        raw = raw.encode('utf-8')
    text = raw.decode('utf-8-sig')
    source_hash = hashlib.sha256(raw).hexdigest()
    roles = {user_name: 'user', ai_name: 'assistant'}
    title = ''; messages = []; current = None; body = []; fence = None; occurrence = {}

    def finish():
        if current is None:
            return
        # Export separators delimit messages, not internal horizontal rules.
        lines = list(body)
        while lines and not lines[-1].strip():
            lines.pop()
        if lines and lines[-1].strip() == '---':
            lines.pop()
        content = '\n'.join(lines).strip('\n')
        if not content.strip():
            raise ValueError('Empty or unrecognized message body')
        speaker, stamp = current
        when = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        role = roles.get(speaker)
        if role is None:
            raise ValueError('Unknown speaker; explicit identity mapping required')
        key = (stamp, speaker); ordinal = occurrence.get(key, 0); occurrence[key] = ordinal + 1
        identifier = hashlib.sha256(f'{session_id}\0{stamp}\0{speaker}\0{ordinal}'.encode()).hexdigest()
        attachments = []
        for reference in ATTACHMENT.findall(content):
            path = reference.strip().strip('<>')
            if not path.startswith('attachments/'):
                continue
            decoded = unquote(path)
            pure = PurePosixPath(decoded)
            if '..' in pure.parts or '\\' in decoded or pure.is_absolute():
                raise ValueError('Unsafe attachment reference')
            attachments.append({'relative_path': path, 'status': 'not_imported'})
        messages.append({'id': identifier, 'role': role, 'content': content,
            'created_at': when.astimezone(timezone.utc).isoformat(), 'aru': {
                'speaker': speaker, 'ai_id': ai_id if role == 'assistant' else None,
                'sequence': len(messages), 'original_timestamp': stamp,
                'attachments': attachments, 'source_sha256': source_hash,
                'parser_version': 1}})

    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(('```', '~~~')):
            marker = stripped[:3]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            if current is not None:
                body.append(line)
            continue
        match = HEADER.match(line) if fence is None else None
        if match:
            finish(); current = (match['speaker'].strip(), match['stamp']); body = []
        elif fence is None and line.startswith('# ') and current is None:
            if title:
                raise ValueError('Multiple conversation titles')
            title = line[2:].strip()
        elif current is not None:
            # Do not merge malformed export headers into someone else's speech.
            if fence is None and re.match(r'^#{2,6}\s+', line) and re.search(r'\d{4}-\d{2}-\d{2}T', line):
                raise ValueError('Unsupported message header or missing timezone')
            body.append(line)
        elif line.strip() not in ('', '---'):
            raise ValueError('Unrecognized preamble; inspect export format')
    if fence:
        raise ValueError('Unclosed code fence')
    finish()
    if not title or not messages:
        raise ValueError('Conversation title and recognized message headers required')
    return {'id': session_id, 'title': title, 'messages': messages,
            'source_sha256': source_hash, 'parser_version': 1,
            'warning': 'Preview only; retain original bytes separately. No attachments fetched.'}
