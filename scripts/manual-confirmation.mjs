import {createInterface} from 'node:readline';

// Human confirmation is an explicit CLI option; never an automatic Agent action.
export function withManualConfirmation(options,{input=process.stdin,output=process.stderr}={}) {
  if(!options.manual)return options;
  if(!input.isTTY)throw new Error('--manual requires an interactive terminal and a visible browser; run this command in your local terminal');
  return {...options,confirmReady:page=>new Promise((resolve,reject)=>{
    const rl=createInterface({input,output,terminal:false});let settled=false;
    const cancelled=()=>finish(new Error('Manual capture cancelled'));
    const closed=()=>finish(new Error('Browser closed before capture confirmation'));
    function finish(error){if(settled)return;settled=true;process.off('SIGINT',cancelled);page.off('close',closed);rl.close();error?reject(error):resolve();}
    rl.once('line',()=>finish());
    rl.once('close',()=>finish(new Error('Manual capture cancelled before confirmation')));
    rl.once('SIGINT',()=>finish(new Error('Manual capture cancelled')));
    process.once('SIGINT',cancelled);
    page.once('close',closed);
    output.write(`Browser opened: ${page.url()}\nComplete verification or adjust the page in the browser. Press Enter here when the target page is ready; the UI snapshot starts only after confirmation.\n`);
  })};
}

export async function waitForConfirmation(page,options) {
  if(!options.manual)return {mode:'automatic',confirmed:false};
  if(typeof options.confirmReady!=='function')throw new Error('Manual mode requires a confirmReady callback');
  await options.confirmReady(page);
  if(page.isClosed())throw new Error('Browser closed before capture');
  return {mode:'manual',confirmed:true,url:page.url()};
}
