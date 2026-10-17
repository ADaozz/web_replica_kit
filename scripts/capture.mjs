#!/usr/bin/env node
import {withManualConfirmation} from './manual-confirmation.mjs';
import {capture} from '../capture.mjs';
import {parseArgs} from './cli-options.mjs';
try {
  const result=await capture(withManualConfirmation(parseArgs(process.argv.slice(2))));
  console.log(JSON.stringify(result));
  process.exitCode=result.status==='partial'?2:0;
}catch(error){
  console.error(error.message);
  console.log(JSON.stringify({status:'failed',error:error.message}));
  process.exitCode=1;
}
