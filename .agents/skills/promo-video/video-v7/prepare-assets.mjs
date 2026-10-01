import {mkdirSync,readFileSync,writeFileSync,cpSync} from 'node:fs';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
const HERE=import.meta.dirname,ROOT=resolve(HERE,'../../../..'),C=JSON.parse(readFileSync(join(HERE,'src/copy.json'))),B=JSON.parse((()=>{try{return readFileSync(join(HERE,'src/bounds.json'),'utf8')}catch{return '{}'}})());
for(const lang of process.argv.slice(2).length?process.argv.slice(2):Object.keys(C)){const src=join(ROOT,'store-assets/promo/v7/assets',lang),dest=join(HERE,'public/textures',lang);mkdirSync(dest,{recursive:true});cpSync(src,dest,{recursive:true});const a=JSON.parse(readFileSync(join(src,'capture.json'))),w=JSON.parse(readFileSync(join(src,'capture-workflow.json')));B[lang]={bounds:{...a.bounds,...w.bounds},rows:w.rows};
for(const id of ['math','mermaid','dot','protein','chemistry','take']){const box=a.bounds[id+':.msg.assistant'];const x=Math.floor(box.x*2),y=Math.floor(box.y*2),width=Math.ceil(box.width*2),height=Math.ceil(box.height*2);for(const name of (id==='protein'?['protein','protein-rotated']:[id]))execFileSync('ffmpeg',['-y','-i',join(src,name+'.png'),'-vf',`crop=${width}:${height}:${x}:${y}`,'-frames:v','1',join(dest,'crop-'+name+'.png')],{stdio:'ignore'});}}
writeFileSync(join(HERE,'src/bounds.json'),JSON.stringify(B,null,2));console.log('prepared',Object.keys(B));

// Preserve the accepted actual model rendering after every legacy capture refresh.
await import('./prepare-native.mjs');
