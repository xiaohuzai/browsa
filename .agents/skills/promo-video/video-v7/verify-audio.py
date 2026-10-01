from pathlib import Path
import subprocess,json
import numpy as np
R=Path('/Users/yan.huang/work/browsa');O=R/'store-assets/promo/v7/analysis';V=R/'docs/assets/promo/browsa-promo-v7-zh.mp4';N=R/'docs/assets/promo/browsa-promo-v7-zh-nobgm.mp4';rate=48000
# Align actual final AAC samples against the same-timeline PCM WAV, independent of container metadata.
def samples(path):
 b=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-vn','-ac','1','-ar',str(rate),'-f','f32le','-']);return np.frombuffer(b,dtype='<f4')
x=samples(V);ref=samples(R/'store-assets/promo/v7/main-audio-shared.wav');y=samples(N)
# Use correlation over first eight seconds, ±one tenth second.
from scipy.signal import correlate,correlation_lags
cor=correlate(x[:rate*8],ref[:rate*8],method='fft');lags=correlation_lags(rate*8,rate*8);mask=abs(lags)<4800;lag=int(lags[mask][np.argmax(cor[mask])]);off=lag/rate
T=.4615385705334432;cuts=[0,12,20,24,36,46,52,56,62,64,66,70,90,94,108,112,122,130,140,148];events=[7,26,31,38,41,81,95,97,99,102,114,119,124,125,133]
ce=[{'beat':n,'frame':round(n*T*30),'error_frames':(round(n*T*30)/30-n*T-off)*30} for n in cuts]
clicks=[]
for n in events:
 t=round(n*T*30)/30;start=round((t-.07)*rate);end=round((t+.07)*rate);peak=(start+int(np.argmax(abs(y[start:end]))))/rate;clicks.append({'beat':n,'target_seconds':t,'peak_seconds':peak,'error_frames':(peak-t)*30})
report={'date':'2026-10-01','pipeline':'Remotion4.0.372 WAV, ffmpeg AAC192k mux','final_audio_offset_seconds':off,'max_cut_grid_error_frames':max(abs(c['error_frames']) for c in ce),'cuts':ce,'click_peaks':clicks,'max_click_error_frames':max(abs(c['error_frames']) for c in clicks),'peak_dbfs':float(20*np.log10(max(abs(x))))}
assert report['max_cut_grid_error_frames']<=3;assert report['max_click_error_frames']<=1;assert report['peak_dbfs']<0
(O/'final-beat-check.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
