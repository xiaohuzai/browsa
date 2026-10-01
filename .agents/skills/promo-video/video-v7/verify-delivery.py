from pathlib import Path
import json,subprocess,hashlib,re
R=Path('/Users/yan.huang/work/browsa'); O=R/'store-assets/promo/v7'
C=json.loads((R/'.agents/skills/promo-video/video-v7/src/copy.json').read_text()); result={'files':[],'locales':{},'missing':[]}
def run(args):return subprocess.check_output(args,text=True).strip()
def video_hash(p):
 return run(['ffmpeg','-v','error','-i',str(p),'-map','0:v:0','-c','copy','-f','hash','-hash','sha256','-'])
for lang,c in C.items():
 slug=lang.lower(); asset=O/'assets'/lang
 cap=json.loads((asset/'capture.json').read_text()); work=json.loads((asset/'capture-workflow.json').read_text())
 conversation=json.loads((O/'conversation'/lang/'capture.json').read_text());assert not conversation['errors'];assert conversation['agentRequest']['backfill'];assert conversation['secondAgentRequest']['backfill'];
 native=json.loads((O/'native'/lang/'capture.json').read_text());assert native['actualExtension'];assert native['metrics']['errors']==0;result['locales'][lang]={'capture_checks':cap.get('checks'), 'workflow_checks':work.get('checks'),'native_checks':native.get('checks')}
 for base in [R/'docs/assets/promo'/('browsa-promo-v7-'+slug), *[O/'growth'/('browsa-'+k+'-v7-'+slug) for k in ['tech','podcast','agent']]]:
  main=Path(str(base)+'.mp4'); nobgm=Path(str(base)+'-nobgm.mp4')
  if not main.exists() or not nobgm.exists():result['missing'].append(str(base));continue
  p=json.loads(run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(main)]));v=next(x for x in p['streams'] if x['codec_type']=='video');a=next(x for x in p['streams'] if x['codec_type']=='audio')
  assert(v['width'],v['height'],v['r_frame_rate'])==(1920,1080,'30/1')
  expected=2049 if 'browsa-promo' in main.name else 498 if 'podcast' in main.name else 720;assert int(v['nb_frames'])==expected,(main,v['nb_frames'])
  h=video_hash(main);same=h==video_hash(nobgm);assert same
  subprocess.run(['ffmpeg','-v','error','-threads','2','-i',str(main),'-f','null','-'],check=True,stdout=subprocess.DEVNULL)
  result['files'].append({'path':str(main.relative_to(R)),'duration':float(p['format']['duration']),'frames':int(v['nb_frames']),'audio':a['codec_name'],'identical_sfx_only_picture':same,'video_hash':h})
 readme=R/('README.md' if lang=='en' else 'README.zh-CN.md' if lang=='zh' else 'README.'+lang+'.md');landing=R/('docs/index.html' if lang=='zh' else 'docs/'+slug+'/index.html')
 assert 'demo-v16-'+slug+'.gif' in readme.read_text();assert 'browsa-promo-v7-'+slug+'.mp4' in landing.read_text()
 assert set(c)==set(C['zh'])
for path in ['docs/guide/providers.html','docs/en/guide/providers.html']:
 s=(R/path).read_text();blocks=re.findall(r'<pre[^>]*>(.*?)</pre>',s,re.S)
 import html
 found=0
 for block in blocks:
  raw=html.unescape(re.sub('<[^>]+>','',block))
  if '"bridges"' in raw and raw.lstrip().startswith('{'):json.loads(raw);found+=1
 assert found>0,path
result['complete']=not result['missing'] and len(result['files'])==28
(O/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'complete':result['complete'],'movies':len(result['files']),'missing':result['missing']},ensure_ascii=False))
