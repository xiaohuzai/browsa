import React from 'react';
import {registerRoot,Composition} from 'remotion';
import {Main} from './Main';
import {GrowthClip,CLIP_TOTAL,clipTotal} from './GrowthClips';
import {TOTAL,FPS} from './timeline';
registerRoot(()=>React.createElement(React.Fragment,null,React.createElement(Composition,{id:'BrowsaPromo',component:Main,durationInFrames:TOTAL,fps:FPS,width:1920,height:1080,defaultProps:{lang:'zh',bgm:true,voice:false}}),React.createElement(Composition,{id:'BrowsaGrowth',component:GrowthClip,durationInFrames:CLIP_TOTAL,fps:FPS,width:1920,height:1080,defaultProps:{lang:'zh',kind:'tech',bgm:true},calculateMetadata:({props}:any)=>({durationInFrames:clipTotal(props.kind||'tech')})})));
