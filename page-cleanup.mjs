// One pass over the settled page. Never clicks, dismisses dialogs, or waits for
// another state. Only explicit noise markers and caller-selected nodes change.
export async function cleanPage(page,{keepNoise=false,removeSelector}={}) {
  return page.evaluate(({keepNoise,removeSelector})=>{
    if(removeSelector)document.createDocumentFragment().querySelector(removeSelector);
    const removed=[],candidates=[],roots=[];
    const ads='#carbonads,#carbon-custom,.carbon-ad,.adsbygoogle,ins[data-ad-client],[data-ad-slot],.advertisement,.ad-banner,.ad-container,[aria-label="advertisement" i],[aria-label="广告"]';
    const loaders='#preloader,#page-loader,.page-loader,.loading-overlay,.loading-screen,[data-loading-overlay]';
    const dialogs='dialog[open],[role="dialog"],[role="alertdialog"],sl-dialog[open]';
    const promotional=/special offer|sponsored|migrate to|限时优惠|订阅推送/i;
    function visible(el){return [el,...(el.shadowRoot?.children || [])].some(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return !!(r.width&&r.height)&&s.display!=='none'&&s.visibility!=='hidden';});}
    function selector(el){
      const part=el.localName+(el.id?'#'+CSS.escape(el.id):`:nth-of-type(${[...el.parentNode.children].filter(n=>n.localName===el.localName).indexOf(el)+1})`);
      const parent=el.parentElement || el.getRootNode().host;
      return parent?selector(parent)+(el.parentElement?' > ':' >>> ')+part:part;
    }
    function scan(root){
      roots.push(root);
      for(const el of root.querySelectorAll('*')) {
        if(['html','head','body','script','style','link','meta'].includes(el.localName))continue;
        const label=()=>((el.getAttribute('aria-label')||el.getAttribute('label')||'')+' '+(el.textContent || '')).trim();
        let reason;
        if(removeSelector&&el.matches(removeSelector))reason='user-selector';
        else if(!keepNoise&&el.matches(ads))reason='advertisement';
        else if(!keepNoise&&el.matches(loaders)&&!el.querySelector('main,article,nav,form')&&label().length<200&&(!label()||/loading|please wait|加载|请稍候/i.test(label())))reason='loading-placeholder';
        else if(!keepNoise&&el.matches(dialogs)&&visible(el)){
          const title=el.getAttribute('aria-label')||el.getAttribute('label')||el.querySelector('h1,h2,h3,[slot=label]')?.textContent||'';
          if(promotional.test(label())||/newsletter|广告|推广|促销/i.test(title)||/^newsletter/i.test(label()))reason='promotional-dialog';
        }
        if(reason)candidates.push({el,reason,selector:selector(el),blocking:visible(el)&&(el.matches(dialogs)||['fixed','absolute'].includes(getComputedStyle(el).position))});
        if(el.shadowRoot)scan(el.shadowRoot);
      }
    }
    scan(document);
    let removedBlocking=false;
    for(const {el,reason,selector,blocking} of candidates) {
      if(!el.isConnected)continue;
      removed.push({selector,tag:el.localName,reason});removedBlocking ||= blocking;el.remove();
    }
    // A removed modal can otherwise leave its page permanently scroll-locked.
    const remainingDialog=roots.some(root=>(root===document||root.host?.isConnected)&&[...root.querySelectorAll(dialogs)].some(visible));
    if(removedBlocking&&!remainingDialog) {
      for(const root of roots)if(root===document||root.host?.isConnected)for(const el of root.querySelectorAll('.modal-backdrop,.ant-modal-mask')) {
        removed.push({selector:selector(el),tag:el.localName,reason:'orphaned-backdrop'});el.remove();
      }
      for(const el of [document.documentElement,document.body].filter(Boolean)) {
        el.classList.remove('sl-scroll-lock','modal-open','ant-scrolling-effect');
        el.style.removeProperty('--sl-scroll-lock-size');
        if(el.style.overflow==='hidden')el.style.removeProperty('overflow');
      }
    }
    return {automatic:!keepNoise,removeSelector:removeSelector || null,removedCount:removed.length,removed,limitations:['Conservative markers only; unmarked ads and loaders may remain. Removing a loader does not render unfinished content. No controls were clicked.']};
  },{keepNoise,removeSelector});
}
