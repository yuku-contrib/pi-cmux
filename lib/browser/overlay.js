// Injected into the page world, not a trusted content world. Never treat this API as authentication.
function installPiAnnotations(config) {
  const key = '__piCmuxAnnotationsV1';
  if (globalThis[key]) return globalThis[key].attach(config);
  if (!document.body || !['text/html', 'application/xhtml+xml'].includes(document.contentType)) {
    throw new Error('Pi annotations need a loaded HTML document');
  }
  const host = document.createElement('div');
  host.id = 'pi-cmux-annotations';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      :host { color-scheme: dark; }
      [hidden] { display: none !important; }
      button, textarea { font: inherit; }
      button { cursor: pointer; }
      button:focus-visible, textarea:focus-visible { outline: 1px solid #e6b273; outline-offset: 2px; }
      .ring { position: fixed; border: 1.5px solid #dba25b; border-radius: 5px; pointer-events: none; }
      .hover { border-style: dashed; }
      .note { position: fixed; width: min(290px, calc(100vw - 24px)); padding: 8px; pointer-events: auto; background: #202127; color: #eee; border: 1px solid #41434c; border-radius: 9px; box-shadow: 0 4px 16px #0002; font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .input { display: flex; align-items: flex-start; gap: 6px; }
      textarea { flex: 1; min-width: 0; height: 28px; max-height: 96px; padding: 4px; border: none; resize: none; background: transparent; color: #eee; line-height: 20px; }
      textarea::placeholder { color: #a4a7b1; }
      .close { border: 0; background: none; color: #a4a7b1; width: 24px; height: 26px; font-size: 17px; }
      .footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 5px; }
      .status { color: #a4a7b1; font-size: 10px; padding-left: 4px; }
      .send { border: 0; border-radius: 5px; background: #e6b273; color: #332619; padding: 3px 9px; font-size: 11px; }
      .send:disabled { opacity: .4; cursor: default; }
      .launcher { position: fixed; bottom: 16px; right: 16px; display: flex; align-items: center; gap: 9px; pointer-events: auto; background: #202127; color: #eee; border: 1px solid #41434c; border-radius: 7px; padding: 7px 10px; font: 12px -apple-system, sans-serif; }
      .launcher::after { content: ''; width: 26px; height: 14px; border-radius: 8px; background: radial-gradient(circle at 7px 7px, #d1d3dc 4px, transparent 5px), #4b4e59; }
      .launcher[aria-checked="true"]::after { background: radial-gradient(circle at 19px 7px, #30271e 4px, transparent 5px), #e6b273; }
    </style>
    <div class="ring" hidden></div>
    <div class="ring hover" hidden></div>
    <section class="note" aria-label="Browser annotation" hidden>
      <div class="input"><textarea rows="1" maxlength="2000" aria-label="Annotation text" placeholder="Write a note…"></textarea><button class="close" aria-label="Close note" title="Close / cancel · Esc">×</button></div>
      <div class="footer"><span class="status" role="status">Confirm in Pi before sending</span><button class="send" title="Send to Pi · ⌘ / Ctrl + Enter" disabled>Send ↑</button></div>
    </section>
    <button class="launcher" role="switch" aria-label="Annotate" aria-checked="false" title="Switch annotations on to select an element">Annotate</button>
  `;
  const $ = selector => root.querySelector(selector);
  const note = $('.note');
  const text = $('textarea');
  const drafts = new WeakMap();
  let owner, documentId, expires = 0, leaseMs, watchdog;
  let documentUrl = location.href;
  let enabled = false, selected = null, hovered = null, pending = null, stale = false, lastRect;

  const clean = (value, limit) => String(value).replace(/\r\n?|[\u2028\u2029]/gu, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, limit);
  const online = () => expires > Date.now();
  function selector(element) {
    if (element.id) return `#${CSS.escape(element.id)}`.slice(0, 400);
    const parts = [];
    for (let node = element; node && node !== document.documentElement && parts.length < 6; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.tagName === node.tagName) : [node];
      parts.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ').slice(0, 400);
  }
  function description(element) {
    return {
      selector: clean(selector(element), 400),
      // Omit the entire excerpt for controls/editors, including their containers.
      // innerText on a container would otherwise include unsent editable content.
      text: element.closest('input, textarea, select, [contenteditable]') || element.querySelector('input, textarea, select, [contenteditable]')
        ? '' : clean((element.innerText || '').trim(), 240),
    };
  }
  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function position(ring, rect) {
    Object.assign(ring.style, { top: `${rect.top - 3}px`, left: `${rect.left - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  }
  function layout() {
    const rect = selected?.isConnected ? selected.getBoundingClientRect() : lastRect;
    if (rect) lastRect = rect;
    const visible = enabled && selected && rect && rect.bottom > 0 && rect.top < innerHeight;
    $('.ring').hidden = note.hidden = !visible;
    $('.hover').hidden = !enabled || !hovered || hovered === selected || Boolean(pending);
    if (!$('.hover').hidden) position($('.hover'), hovered.getBoundingClientRect());
    if (!visible) return;
    position($('.ring'), rect);
    const left = Math.max(12, Math.min(rect.left, innerWidth - note.offsetWidth - 12));
    const below = rect.bottom + 9;
    const bottomLimit = innerHeight - 60; // Keep the toggle accessible below the composer.
    const top = below + note.offsetHeight <= bottomLimit ? below : rect.top - note.offsetHeight - 9;
    note.style.left = `${left}px`;
    note.style.top = `${Math.max(12, Math.min(top, bottomLimit - note.offsetHeight))}px`;
  }
  function controls() {
    $('.launcher').setAttribute('aria-checked', String(enabled));
    text.readOnly = Boolean(pending);
    $('.send').disabled = !online() || !text.value.trim() || !selected || stale || Boolean(pending);
    layout();
  }
  function changed() {
    if (selected) drafts.set(selected, text.value);
    text.style.height = '28px';
    text.style.height = `${Math.min(96, Math.max(28, text.scrollHeight))}px`;
    if (!stale) $('.status').textContent = online() ? 'Confirm in Pi before sending' : 'Pi disconnected · draft kept';
    $('.launcher').textContent = online() ? 'Annotate' : 'Disconnected · Annotate';
    controls();
  }
  function choose(element) {
    const retained = stale ? text.value : null;
    selected = element;
    stale = false;
    text.value = retained ?? drafts.get(element) ?? '';
    note.setAttribute('aria-label', `Note on ${element.localName}`);
    layout();
    changed();
    text.focus();
  }
  function cancel() {
    pending = null;
    enabled = false;
    hovered = null;
    $('.launcher').textContent = online() ? 'Annotate' : 'Disconnected · Annotate';
    $('.launcher').title = 'Switch annotations on; your draft is kept';
    controls();
    $('.launcher').focus();
  }
  function checkSelection() {
    if (documentUrl !== location.href) {
      documentUrl = location.href;
      pending = null;
      stale = Boolean(selected);
      $('.status').textContent = 'Page changed · select again';
    }
    if (selected && !selected.isConnected) {
      pending = null;
      stale = true;
      $('.status').textContent = 'Element removed · select again';
    }
    if (pending) {
      const current = description(selected);
      if (current.selector !== pending.selector || current.text !== pending.text) {
        pending = null;
        stale = true;
        $('.status').textContent = 'Element changed · select again';
      }
    }
    controls();
  }
  function send() {
    checkSelection();
    if ($('.send').disabled) return;
    const comment = clean(text.value, 2000).trim();
    if (!comment || comment.split('\n').length > 20 || location.href.length > 2048) {
      $('.status').textContent = 'Use up to 20 lines and a shorter page URL';
      return;
    }
    pending = { id: randomId(), url: location.href, title: clean(document.title, 160), ...description(selected), comment };
    $('.status').textContent = 'Waiting for confirmation in Pi…';
    controls();
  }
  function target(event) {
    if (event.composedPath().includes(host) || !(event.target instanceof Element)) return null;
    const element = event.target;
    return element === document.body || element === document.documentElement || ['SCRIPT', 'STYLE', 'IFRAME'].includes(element.tagName) ? null : element;
  }
  document.addEventListener('pointermove', event => {
    if (!enabled) return;
    hovered = target(event);
    layout();
  });
  document.addEventListener('click', event => {
    if (!enabled) return;
    const element = target(event);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!pending) choose(element);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && enabled) { event.preventDefault(); cancel(); }
  });
  text.addEventListener('input', changed);
  text.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send(); }
  });
  $('.close').addEventListener('click', cancel);
  $('.send').addEventListener('click', send);
  $('.launcher').addEventListener('click', () => {
    if (enabled) { cancel(); return; }
    enabled = true;
    $('.launcher').textContent = online() ? 'Annotate' : 'Disconnected · Annotate';
    $('.launcher').title = 'Click an element to write a note. Switch off or press Escape to browse normally.';
    if (selected) selected.scrollIntoView({ block: 'nearest' });
    controls();
    if (selected && !note.hidden) text.focus();
  });
  addEventListener('resize', layout);
  addEventListener('scroll', layout, { passive: true });

  function disconnect(expectedOwner) {
    if (expectedOwner !== owner) return;
    expires = 0;
    pending = null;
    enabled = false;
    hovered = null;
    clearInterval(watchdog);
    watchdog = undefined;
    $('.status').textContent = 'Pi disconnected · draft kept';
    $('.launcher').textContent = 'Disconnected · Annotate';
    $('.launcher').title = 'Pi disconnected; reconnect the bridge to send. Drafts are kept.';
    controls();
  }
  function poll(expectedOwner, acks = []) {
    if (expectedOwner !== owner || !host.isConnected) throw new Error('Pi annotation owner changed');
    expires = Date.now() + leaseMs;
    // A successful poll can recover the same owner after its lease expired.
    if (watchdog === undefined) {
      watchdog = setInterval(() => { if (!online()) disconnect(owner); }, 1000);
      $('.launcher').textContent = 'Annotate';
      $('.launcher').title = 'Switch annotations on; your draft is kept';
      if (!stale) $('.status').textContent = 'Confirm in Pi before sending';
    }
    checkSelection();
    for (const ack of acks) {
      if (!pending || ack.documentId !== documentId || ack.id !== pending.id) continue;
      const status = ack.status;
      if (!['queued', 'rejected', 'cancelled', 'failed'].includes(status)) continue;
      pending = null;
      $('.status').textContent = status === 'queued' ? 'Queued in Pi' : 'Not sent · draft kept';
      if (status === 'queued') {
        drafts.delete(selected);
        text.value = '';
        enabled = false;
        hovered = null;
        $('.launcher').textContent = 'Queued in Pi · Annotate';
      }
    }
    controls();
    return { version: 1, owner, documentId, url: location.href, editing: enabled || Boolean(pending), pending: pending ? { ...pending } : null };
  }
  function attach(next) {
    if (owner && next.owner !== owner && online()) throw new Error('Another Pi annotation bridge owns this page');
    if (next.owner !== owner) {
      owner = next.owner;
      documentId = next.documentId;
      pending = null; // Never replay a submission after reload or owner replacement.
    }
    leaseMs = next.leaseMs;
    clearInterval(watchdog);
    watchdog = undefined;
    $('.status').textContent = 'Confirm in Pi before sending';
    $('.launcher').textContent = 'Annotate';
    return poll(owner);
  }
  globalThis[key] = { attach, poll, disconnect };
  return attach(config);
}
