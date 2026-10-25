import type {ModelMessage,ModelTool,ModelReply} from '../../chat/provider.js';
import type {ChatTurn} from '@sakie/contracts';
export interface ChatMemory {
 context(turn:ChatTurn):ModelMessage[];
 tools(turn:ChatTurn):ModelTool[];
 runTool(turn:ChatTurn,name:string,args:string):Promise<string>;
 completed(turn:ChatTurn):void;
 assertCurrent(turn:ChatTurn):void;
 release(turnId:string):void;
 onInvalidate(handler:(turnId:string)=>void):void;
 isEnabled():boolean;
 readonly maxToolRounds:number;
}
