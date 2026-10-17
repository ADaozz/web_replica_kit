// Lightweight diagnostics only: no navigation, retries or site-specific actions.
export function assessRenderedPage({title='',url='',text='',visibleMedia=0,hasMainContent=false}={}) {
  const content=text.trim();
  if(/^(?:just a moment[.!…\s]*|attention required.*cloudflare|verify (?:that )?you are human[.!…\s]*|checking your browser[.!…\s]*)$/i.test(title.trim()) ||
      /^(?:verify (?:that )?you are human|enable javascript and cookies|checking your browser)(?:\b|[.!…])/i.test(content))return 'verification-gate';
  if(/^(?:loading|please wait|加载中|正在加载|请稍候)[.!…\s]*$/i.test(content))return 'loading-placeholder';
  if(!content && !visibleMedia && !hasMainContent)return 'empty-rendered-body';
  if(/^(?:undefined|null|error|internal server error|something went wrong|(?:404|403|500)(?:\s+(?:not found|forbidden|internal server error))?)[.!…\s]*$/i.test(content))return 'unknown';
  if(url){try{new URL(url);}catch{return 'unknown';}}
  return 'content-observed';
}

export async function inspectPageReadiness(page,{readySelectorMatched=null}={}) {
  const observed=await page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});};
    const media=[],main=[];
    function walk(root){
      media.push(...[...root.querySelectorAll('img,svg,canvas,video')].filter(visible));
      main.push(...[...root.querySelectorAll('main,article,[role=main],form')].filter(el=>visible(el)&&(el.innerText?.trim()||[...el.querySelectorAll('input,button,select,textarea')].some(visible))));
      for(const el of root.querySelectorAll('*'))if(el.shadowRoot)walk(el.shadowRoot);
    }
    walk(document);
    // innerText excludes hidden light-DOM text; include rendered shadow text too.
    const texts=[document.body?.innerText || ''];
    function shadowText(root){for(const el of root.querySelectorAll('*'))if(el.shadowRoot){for(const child of el.shadowRoot.children)if(visible(child))texts.push(child.innerText || '');shadowText(el.shadowRoot);}}
    shadowText(document);
    return {url:location.href,title:document.title,text:texts.join('\n').trim(),visibleMedia:media.length,hasMainContent:main.length>0};
  });
  const status=assessRenderedPage(observed);
  const reasons={
    'verification-gate':'Known verification-page title or leading verification message observed.',
    'loading-placeholder':'Only a typical loading or wait message is visible.',
    'empty-rendered-body':'No visible body text, meaningful main content or visible media observed.',
    unknown:'Readiness could not be established from the observed page; an error-like message or invalid URL may be present.'
  };
  return {status,reason:reasons[status] || null,readySelectorMatched};
}
