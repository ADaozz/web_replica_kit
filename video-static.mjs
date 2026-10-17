// Decode only an already observed media resource, isolated from website scripts.
// This is a fallback for cross-origin videos whose current pixels cannot be read.
export async function decodeVideoFrame(context,body,contentType,time,{maxBytes=12*1024*1024}={}) {
  const page=await context.newPage();
  try {
    await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:"><video muted></video>');
    return await page.evaluate(async({base64,contentType,time,maxBytes})=>{
      const video=document.querySelector('video');
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:contentType}));
      let timer;
      try {
        return await Promise.race([new Promise((resolve,reject)=>{
          video.onerror=()=>reject(new Error('Saved video cannot be decoded'));
          const exportFrame=()=>{
            try {
              if(!video.videoWidth || !video.videoHeight || video.videoWidth*video.videoHeight>16777216)throw new Error('Video frame dimensions exceed export budget or are unavailable');
              const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
              canvas.getContext('2d').drawImage(video,0,0);
              const data=canvas.toDataURL('image/png');
              if(Math.ceil((data.length-22)*3/4)>maxBytes)throw new Error('Video frame exceeds file size budget');
              resolve(data);
            }catch(error){reject(error);}
          };
          video.onloadeddata=()=>{
            if(time>0){video.onseeked=exportFrame;video.currentTime=Math.min(time+0.000001,Math.max(0,video.duration-0.001));}
            else exportFrame();
          };
          video.src=url;video.load();
        }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Video frame decode timed out')),12000);})]);
      }finally{clearTimeout(timer);video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
    },{base64:body.toString('base64'),contentType,time,maxBytes});
  }finally{await page.close();}
}
