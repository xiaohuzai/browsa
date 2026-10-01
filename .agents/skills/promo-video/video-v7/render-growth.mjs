import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
const HERE=import.meta.dirname,ROOT=resolve(HERE,'../../../..'),OUT=join(ROOT,'store-assets/promo/v7/growth'),C=JSON.parse(readFileSync(join(HERE,'src/copy.json')));
mkdirSync(OUT,{recursive:true});
const cli=join(HERE,'node_modules/.bin/remotion');
const langs=process.argv.slice(2).filter(x=>!x.startsWith('--'));
for(const lang of langs.length?langs:Object.keys(C))for(const kind of ['tech','podcast','agent']){
 const props=join(OUT,`${kind}-${lang}.json`),dest=join(OUT,`browsa-${kind}-v7-${lang.toLowerCase()}.mp4`);
 writeFileSync(props,JSON.stringify({lang,kind,bgm:true}));
 if(!process.argv.includes('--reuse-video'))execFileSync(cli,['render','src/index.ts','BrowsaGrowth',dest,'--props='+props,'--codec=h264','--crf=20','--concurrency=4','--muted'],{cwd:HERE,stdio:'inherit'});
 for(const bgm of [true,false]){
  writeFileSync(props,JSON.stringify({lang,kind,bgm}));
  // zh's actual session-copy occurs at beat16; all other illustration copies at beat19.
  const group=kind==='agent'&&lang==='zh'?'agent-live':kind;
  const wav=join(OUT,`${group}-${bgm?'music':'sfx'}-shared.wav`);
  if(!existsSync(wav)||process.argv.includes('--refresh-audio'))execFileSync(cli,['render','src/index.ts','BrowsaGrowth',wav,'--props='+props,'--codec=wav'],{cwd:HERE,stdio:'inherit'});
  const target=bgm?dest:dest.replace('.mp4','-nobgm.mp4'),tmp=target+'.tmp.mp4';
  execFileSync('ffmpeg',['-y','-i',dest,'-i',wav,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',tmp],{stdio:'inherit'});renameSync(tmp,target);
 }
}
