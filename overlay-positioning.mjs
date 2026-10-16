// Native CSS (including portal transforms and dialog top-layer layout) is authoritative.
// Opt-in measured anchoring is used only when capture explicitly requests it.
export function updateMeasuredOverlay(popup, trigger, observation) {
  if (!popup || !trigger || observation?.strategy !== 'measured-anchor') return;
  const a=trigger.getBoundingClientRect(),b=popup.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const x=observation.align==='right'?a.right+observation.dx-b.width:a.left+observation.dx;
  const y=observation.side==='top'?a.top+observation.dy-b.height:a.bottom+observation.dy;
  const dx=x-b.left,dy=y-b.top;
  if (Math.abs(dx)+Math.abs(dy)<0.1) return;
  // Convert the viewport correction through transformed containing ancestors.
  let matrix=new DOMMatrix();
  for (let p=popup.parentElement;p;p=p.parentElement) {
    const transform=getComputedStyle(p).transform;
    if (transform && transform!=='none') matrix=new DOMMatrix(transform).multiply(matrix);
  }
  const inverse=matrix.inverse();
  const local={x:inverse.a*dx+inverse.c*dy,y:inverse.b*dx+inverse.d*dy};
  if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return;
  const previous=popup.__wrkTranslation || {x:0,y:0,original:popup.style.translate === 'none' ? '' : (popup.style.translate || '')};
  previous.x+=local.x;previous.y+=local.y;
  popup.__wrkTranslation=previous;
  // Keep the original transform and individual translate terms intact.
  popup.style.translate=`calc(${previous.original.split(/\s+/)[0] || '0px'} + ${previous.x}px) calc(${previous.original.split(/\s+/)[1] || '0px'} + ${previous.y}px)`;
}

// Enable a fallback only after two real observations prove that script-written
// coordinates track the trigger. Authored native CSS is otherwise left alone.
export function compileOverlayPositioning(diagnostics = []) {
  const samples = new Map(), policies = new Map();
  for (const entry of diagnostics) for (const frame of entry.frames || []) for (const popup of frame.overlays || []) {
    if (frame.index || popup.shadowHost || !popup.triggerRect || !popup.popupRect?.width || !popup.popupRect?.height || !['absolute','fixed'].includes(popup.styles.position)) continue;
    if (!/\b(?:top|left|transform)\s*:/.test(popup.attributes?.style || '')) continue;
    const key=popup.selector, previous=samples.get(key);
    samples.set(key,popup);
    if (!previous || previous.attributes.style===popup.attributes.style || previous.trigger!==popup.trigger) continue;
    const t=popup.triggerRect,p=popup.popupRect,pt=previous.triggerRect,pp=previous.popupRect;
    const moved=Math.abs(t.x-pt.x)+Math.abs(t.y-pt.y)>2;
    const right=Math.abs((p.right-t.right)-(pp.right-pt.right))<2;
    const left=Math.abs((p.left-t.left)-(pp.left-pt.left))<2;
    const bottom=Math.abs((p.top-t.bottom)-(pp.top-pt.bottom))<2;
    const top=Math.abs((p.bottom-t.top)-(pp.bottom-pt.top))<2;
    if (!moved || (!left && !right) || (!top && !bottom)) continue;
    const align=right && Math.abs(p.right-t.right)<Math.abs(p.left-t.left)?'right':'left';
    policies.set(key,{selector:key,trigger:popup.trigger,strategy:'measured-anchor',align,side:bottom?'bottom':'top',dx:align==='right'?p.right-t.right:p.left-t.left,dy:bottom?p.top-t.bottom:p.bottom-t.top,evidence:'observed inline coordinates tracked trigger across distinct layouts'});
  }
  return [...policies.values()];
}
