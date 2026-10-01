// Update chapter 04 plus both crossfades using the full, frozen composition.
// Keep all frame positions and copy each edition's original audio byte stream.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia} from '@remotion/renderer';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {resolve, join} from 'node:path';

const here=import.meta.dirname, root=resolve(here,'../../../..');
const out=join(root,'store-assets/promo/v7/chapter-agent-update');
const copy=JSON.parse(readFileSync(join(here,'src/copy.json'),'utf8'));
const langs=process.argv.slice(2).length?process.argv.slice(2):Object.keys(copy);
const timeline=readFileSync(join(here,'src/timeline.ts'),'utf8');
const interval=Number(timeline.match(/BEAT_INT=([\d.]+)/)[1]);
const transition=Number(timeline.match(/TRANSITION=(\d+)/)[1]);
const begin=Math.round(108*interval*30), end=Math.round(112*interval*30)+transition;
mkdirSync(out,{recursive:true});
const run=(args)=>execFileSync('ffmpeg',['-v','error',...args],{encoding:'utf8'}).trim();
const audioHash=(path)=>run(['-i',path,'-map','0:a:0','-c','copy','-f','hash','-hash','sha256','-']);
const frames=(path)=>Number(JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames','-of','json',path],{encoding:'utf8'})).streams[0].nb_frames);
const serveUrl=await bundle({entryPoint:join(here,'src/index.ts'),publicDir:join(here,'public')});
const report={range:[begin,end-1],method:'full composition interval including both crossfades, audio stream copy',locales:[]};
for(const lang of langs){
  const slug=lang.toLowerCase(), dest=join(root,`docs/assets/promo/browsa-promo-v7-${slug}.mp4`);
  const nobgm=join(root,`docs/assets/promo/browsa-promo-v7-${slug}-nobgm.mp4`);
  const before={mainAudio:audioHash(dest),nobgmAudio:audioHash(nobgm),frames:frames(dest)};
  const inputProps={lang,bgm:true,voice:false};
  const composition=await selectComposition({serveUrl,id:'BrowsaPromo',inputProps});
  const clip=join(out,slug+'-chapter.mp4');
  await renderMedia({serveUrl,composition,inputProps,outputLocation:clip,codec:'h264',crf:20,muted:true,concurrency:2,chromiumOptions:{gl:'swiftshader'},frameRange:[begin,end-1]});
  if(frames(clip)!==end-begin)throw new Error('Unexpected patch frame count: '+lang);
  const tmp=join(out,slug+'-main.mp4');
  run(['-y','-i',dest,'-i',clip,'-filter_complex',`[0:v]trim=end_frame=${begin},setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[0:v]trim=start_frame=${end},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[v]`,'-map','[v]','-map','0:a:0','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',tmp]);
  const ntmp=join(out,slug+'-nobgm.mp4');
  run(['-y','-i',tmp,'-i',nobgm,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',ntmp]);
  const after={mainAudio:audioHash(tmp),nobgmAudio:audioHash(ntmp),frames:frames(tmp)};
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Timing or audio changed: '+lang);
  renameSync(tmp,dest);renameSync(ntmp,nobgm);
  run(['-y','-i',dest,'-vf','select=eq(n\\,1520)','-frames:v','1',join(out,slug+'-1520.png')]);
  report.locales.push({lang,title:copy[lang].chapterCards[3][0],before,after});
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Updated '+lang+' frames '+begin+'–'+(end-1)+', audio unchanged');
}
