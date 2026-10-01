export const FPS=30;
// Cat Walk quarter-note grid measured by waveform template correlation.
export const SOURCE_BEAT0=17.99941120616214;
export const BEAT_INT=.4615385705334432;
export const OUTPUT_AUDIO_OFFSET_SEC=0;
export const beatT=(n:number)=>n*BEAT_INT+OUTPUT_AUDIO_OFFSET_SEC;
export const beatF=(n:number)=>Math.round(beatT(n)*FPS);
export const localBeat=(index:number,n:number)=>beatF(SHOTS[index].beat+n)-SHOTS[index].from;
const defs:[string,number,number][]=[['intro',0,12],['byok',12,20],['chapter-read',20,24],['read',24,36],['followup',36,46],['math',46,52],['mermaid',52,56],['dot',56,62],['protein',62,64],['chemistry',64,66],['chapter-video',66,70],['podcast',70,90],['chapter-continue',90,94],['context',94,108],['chapter-agent',108,112],['take',112,122],['sessions',122,130],['relay',130,140],['outro',140,148]];
export const SHOTS=defs.map(([id,beat,end])=>({id,beat,from:beatF(beat),duration:beatF(end)-beatF(beat)}));
export const TOTAL=beatF(148),TRANSITION=8;
// Source click measured attack peak .8675f; pipeline offset measured 0f.
const click=(beat:number,event:string)=>({from:beatF(beat)-1,target:beatF(beat),duration:8,src:'click-fixed.mp3',volume:.65,event});
export const SFX=[click(7,'extension toolbar opens sidepanel'),click(26,'attach article'),click(31,'send article question'),click(38,'open native follow-up'),click(41,'send follow-up'),click(81,'podcast seek 462s'),click(95,'open Agent selector'),click(97,'choose Claude after Codex'),click(99,'carry current conversation'),click(102,'send with context backfill'),click(114,'copy response'),click(119,'download PNG'),click(124,'open sessions'),click(125,'restore transformer session'),click(133,'copy agent session ID')];
