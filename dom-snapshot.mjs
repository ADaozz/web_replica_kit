// Browser-observed structure only; no source-framework component inference.
export async function captureDOM(page,{maxNodes=5000}={}) {
  return page.evaluate(({maxNodes})=>{
    const elements=[],layout=[],computed=[];
    const types={header:'Header',nav:'Navigation',aside:'Sidebar',main:'Main',section:'Section',article:'Article',form:'Form',button:'Button',input:'Form Control',select:'Form Control',textarea:'Form Control',img:'Media',svg:'Icon'};
    const properties=['display','position','box-sizing','width','height','min-width','max-width','min-height','max-height','margin','padding','gap','row-gap','column-gap','flex','flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis','grid-template-columns','grid-template-rows','grid-auto-flow','grid-column','grid-row','justify-content','align-items','align-self','top','right','bottom','left','transform','overflow','overflow-x','overflow-y','z-index','font','font-family','font-size','font-weight','line-height','letter-spacing','text-align','white-space','color','background','border','border-radius','box-shadow','opacity','visibility','content-visibility','object-fit'];
    let totalNodes=0,shadowRoots=0,iframes=0,canvases=0;
    function walk(el,parentElementId=null,scope='document') {
      if(!el || el.nodeType!==1)return;
      if(['script','noscript','style','link','meta','title','base','template','source','track'].includes(el.localName)||el.matches('input[type=hidden]'))return;
      totalNodes++;
      let id=null;
      if(elements.length<maxNodes){
        id=`element-${String(elements.length+1).padStart(6,'0')}`;
        const sensitive=el.matches('input[type=password],input[type=file]')||/token|secret|password|csrf|api[_-]?key|session|credential|authorization/i.test(`${el.id} ${el.getAttribute('name')||''}`);
        const attributes={};
        for(const {name,value} of el.attributes) {
          if(name.startsWith('data-') && /^[\s]*[\[{]/.test(value))continue;
          if(/^on|token|secret|password|csrf|api[_-]?key|session|credential|authorization|nonce|cookie/i.test(name)||/^data-(?:props|page|state-json|hydration|react-props|initial-state|server-data)$/.test(name)||name==='srcdoc'||(sensitive&&name==='value'))continue;
          if(/^(?:href|src|action)$/i.test(name)&&/^javascript:/i.test(value))continue;
          attributes[name]=value;
        }
        const text=sensitive?'':[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
        elements.push({elementId:id,parentElementId,tag:el.localName,componentType:types[el.localName]||(el.localName.includes('-')?'Custom Element':null),attributes,text,scope,frameId:'main'});
        const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        layout.push({elementId:id,rect:{x:r.x,y:r.y,width:r.width,height:r.height},scroll:{x:el.scrollLeft,y:el.scrollTop,width:el.scrollWidth,height:el.scrollHeight,clientWidth:el.clientWidth,clientHeight:el.clientHeight},visible:!!(r.width&&r.height)&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),inViewport:r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth});
        computed.push({elementId:id,properties:Object.fromEntries(properties.map(p=>[p,s.getPropertyValue(p)]))});
      }
      if(el.localName==='iframe')iframes++;
      if(el.localName==='canvas')canvases++;
      if(el.shadowRoot){shadowRoots++;for(const child of el.shadowRoot.children)walk(child,id,`${id || scope}/shadow`);}
      for(const child of el.children)walk(child,id,scope);
    }
    walk(document.body);
    const html=document.documentElement,r=html.getBoundingClientRect(),style=getComputedStyle(html);
    const documentElement={tag:'html',rect:{x:r.x,y:r.y,width:r.width,height:r.height},scroll:{x:html.scrollLeft,y:html.scrollTop,width:html.scrollWidth,height:html.scrollHeight,clientWidth:html.clientWidth,clientHeight:html.clientHeight},properties:Object.fromEntries(properties.map(p=>[p,style.getPropertyValue(p)]))};
    return {elements,layout,computed,documentElement,totalNodes,truncated:totalNodes>elements.length,shadowRoots,iframes,canvases,viewport:{width:innerWidth,height:innerHeight},pageSize:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},scroll:{x:scrollX,y:scrollY}};
  },{maxNodes});
}
