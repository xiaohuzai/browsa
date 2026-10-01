from pathlib import Path
import subprocess,json,sys
import numpy as np
R=Path('/Users/yan.huang/work/browsa'); results=[]
for lang in sys.argv[1:]:
 p=R/f'docs/assets/promo/browsa-promo-v7-{lang}.mp4';w,h=160,90
 raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-i',str(p),'-vf',f'scale={w}:{h}', '-pix_fmt','gray','-f','rawvideo','-'])
 frames=np.frombuffer(raw,dtype=np.uint8).reshape(-1,h,w);spread=frames.max(axis=(1,2)).astype(int)-frames.min(axis=(1,2)).astype(int);sd=frames.std(axis=(1,2));bad=np.where((spread<8)|(sd<.5))[0].tolist()
 report={'language':lang,'frames':len(frames),'near_solid_frames':bad,'min_std':float(sd.min())};results.append(report);print(json.dumps(report),flush=True)
(Path(R/'store-assets/promo/v7')/('frame-scan-'+ '-'.join(sys.argv[1:])+'.json')).write_text(json.dumps(results,indent=2)+'\n')
assert all(not r['near_solid_frames'] for r in results),results
