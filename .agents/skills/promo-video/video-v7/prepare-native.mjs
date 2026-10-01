import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
const HERE=import.meta.dirname,ROOT=resolve(HERE,'../../../..'),C=JSON.parse(readFileSync(join(HERE,'src/copy.json')));
for(const lang of Object.keys(C)){const src=join(ROOT,'store-assets/promo/v7/native',lang),dest=join(HERE,'public/textures',lang);mkdirSync(dest,{recursive:true});for(const n of ['math','dot','download','downloaded'])copyFileSync(join(src,n+'.png'),join(dest,'native-'+n+'.png'));
for(const n of ['math','dot'])execFileSync('ffmpeg',['-y','-i',join(src,'panel-'+n+'.png'),'-vf',n==='math'?'scale=1320:2240,crop=1260:750:30:150':'scale=1320:2240,crop=1260:1670:30:265','-frames:v','1',join(dest,'crop-'+n+'.png')],{stdio:'ignore'});}
console.log('Native final textures installed for',Object.keys(C));
