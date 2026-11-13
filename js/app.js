// 화면 전환, 입력 처리, 결과 렌더링, 저장·비교·PDF.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const form = $('#productForm');
  const MAX_PHOTOS = 3;
  const MAX_COMPETITORS = 5;
  const MAX_DOCS = 3;
  const MAX_TEXT_CHARS = 200000;
  const MAX_PDF_BYTES = 10 * 1024 * 1024;

  let photos = [];      // { mediaType, data(base64), url }
  let competitors = []; // { name, price, features, reviews }
  let docs = [];        // { name, kind: 'text'|'pdf', text | data }
  let charts = [];
  let current = null;   // 결과 화면에 표시 중인 분석 기록
  let formRecordId = null; // 현재 입력 폼으로 만든 마지막 기록 (사진·자료가 메모리에 남아 있음)

  const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const pct = n => `${n.toFixed(1)}%`;
  const date = ts => new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseNum = v => {
    const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const VERDICT_CLASS = { good: 'v-good', warn: 'v-warn', bad: 'v-bad' };

  /* ---------- 화면 전환 ---------- */
  function go(view) {
    for (const v of ['input', 'result', 'saved', 'compare', 'detail']) $(`#view-${v}`).hidden = v !== view;
    const step = { compare: 'saved', detail: 'result' }[view] || view;
    $$('.step').forEach(b => b.classList.toggle('is-active', b.dataset.go === step));
    if (view === 'saved') renderSaved();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    if (!t || t.disabled) return;
    e.preventDefault();
    if (t.dataset.go === 'result' && !current) return;
    go(t.dataset.go);
  });

  /* ---------- 숫자 입력 ---------- */
  function formatMoney(el) {
    const digits = el.value.replace(/[^\d]/g, '');
    el.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
  }
  document.addEventListener('input', e => {
    if (e.target.matches('[data-money]')) formatMoney(e.target);
    if (e.target.matches('[data-num]')) e.target.value = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
  });

  function readForm() {
    const f = new FormData(form);
    const platform = f.get('platform') || 'custom';
    const catMain = platform === 'custom' ? (f.get('catCustom') || '').trim() : (f.get('catMain') || '');
    const catSub = platform === 'custom' ? '' : (f.get('catSub') || '');
    return {
      name: (f.get('name') || '').trim(),
      catMain,
      catSub,
      category: Platforms.categoryText(catMain, catSub),
      description: (f.get('description') || '').trim(),
      material: (f.get('material') || '').trim(),
      components: (f.get('components') || '').trim(),
      certification: (f.get('certification') || '').trim(),
      size: (f.get('size') || '').trim(),
      cost: parseNum(f.get('cost')),
      price: parseNum(f.get('price')),
      shipping: parseNum(f.get('shipping')),
      packaging: parseNum(f.get('packaging')),
      feeRate: parseNum(f.get('feeRate')),
      platform,
      targetMargin: f.get('targetMargin') === '' ? 30 : parseNum(f.get('targetMargin')),
      photos,
      docs,
      competitors: competitors
        .map(c => ({ name: c.name.trim(), price: parseNum(c.price), features: c.features.trim(), reviews: c.reviews.trim() }))
        .filter(c => c.name || c.price || c.features || c.reviews),
    };
  }

  function validate(p) {
    const errors = [];
    const mark = (name, bad) => form.elements[name].classList.toggle('invalid', bad);
    mark('name', !p.name); if (!p.name) errors.push('상품명');
    const catField = p.platform === 'custom' ? 'catCustom' : 'catMain';
    mark('catMain', false); mark('catCustom', false);
    mark(catField, !p.catMain); if (!p.catMain) errors.push('카테고리');
    mark('description', !p.description); if (!p.description) errors.push('제품 설명');
    mark('cost', p.cost <= 0); if (p.cost <= 0) errors.push('상품 원가');
    mark('price', p.price <= 0); if (p.price <= 0) errors.push('판매가격');
    if (errors.length) return `${errors.join(', ')}을(를) 입력해 주세요.`;
    if (p.feeRate >= 100) { mark('feeRate', true); return '플랫폼 수수료는 100% 미만이어야 합니다.'; }
    mark('feeRate', false);
    if (p.targetMargin >= 100) { mark('targetMargin', true); return '목표 마진율은 100% 미만이어야 합니다.'; }
    mark('targetMargin', false);
    return '';
  }

  /* ---------- 입력 중 실시간 계산 ---------- */
  function liveCalc() {
    const p = readForm();
    renderSummary(p);
    const box = $('#liveCalc');
    if (p.price <= 0 || p.cost <= 0) { box.innerHTML = ''; return; }
    const r = Profit.calc(p);
    box.innerHTML = `
      <div class="mini"><div class="k">예상 순이익</div><div class="v ${r.profit < 0 ? 'neg' : ''}">${won(r.profit)}</div></div>
      <div class="mini"><div class="k">예상 마진율</div><div class="v ${r.margin < 0 ? 'neg' : ''}">${pct(r.margin)}</div></div>
      <div class="mini"><div class="k">수수료</div><div class="v">${won(r.fee)}</div></div>`;
  }

  /* ---------- 오른쪽 입력 요약 (넓은 화면) ---------- */
  function renderSummary(p) {
    const plat = p.platform !== 'custom' ? Platforms.shortLabel(p.platform) : '';
    $('#sumPath').innerHTML = p.catMain
      ? esc([plat, p.category].filter(Boolean).join(' > '))
      : `<span class="muted">${plat ? `${esc(plat)} · ` : ''}카테고리를 골라 주세요</span>`;

    const estimated = p.platform !== 'custom' && Platforms.LIST[p.platform] && !Platforms.LIST[p.platform].verified;
    $('#sumFee').innerHTML = form.elements.feeRate.value.trim()
      ? `수수료 <b>${esc(p.feeRate)}%</b>${estimated ? ' <span class="sum-badge">확인 필요</span>' : ''}`
      : '<span class="muted">수수료를 넣어 주세요</span>';

    if (p.price > 0 && p.cost > 0) {
      const r = Profit.calc(p);
      const rec = Profit.priceForMargin(p, p.targetMargin);
      $('#sumProfit').innerHTML = `
        <div class="sum-row"><span>예상 순이익</span><b class="${r.profit < 0 ? 'neg' : ''}">${won(r.profit)}</b></div>
        <div class="sum-row"><span>예상 마진율</span><b class="${r.margin < 0 ? 'neg' : ''}">${pct(r.margin)}</b></div>
        <div class="sum-row"><span>수수료</span><b>${won(r.fee)}</b></div>
        <div class="sum-row"><span>목표 마진 ${esc(p.targetMargin)}% 권장가</span><b>${rec ? won(rec) : '계산 불가'}</b></div>`;
    } else {
      $('#sumProfit').innerHTML = '<p class="muted small">원가와 판매가격을 넣으면 예상 순이익이 바로 계산됩니다.</p>';
    }

    const checks = [
      ['카테고리', !!p.catMain], ['상품명', !!p.name], ['제품 설명', !!p.description],
      ['상품 원가', p.cost > 0], ['예상 판매가격', p.price > 0],
    ];
    $('#sumCheck').innerHTML = checks.map(([k, ok]) => `<li class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${k}</li>`).join('');
  }
  form.addEventListener('change', liveCalc);

  /* ---------- 플랫폼별 카테고리 ---------- */
  // 대분류 목록을 지금 플랫폼에 맞게 채운다. 직접 입력이면 글자 입력칸을 보여 준다.
  function fillMains(selected = '') {
    const id = form.elements.platform.value;
    const custom = id === 'custom';
    $('#catSelects').hidden = custom;
    $('#catCustomField').hidden = !custom;
    form.elements.catMain.required = !custom;
    form.elements.catCustom.required = custom;
    form.elements.catMain.innerHTML = '<option value="">선택해 주세요</option>'
      + Platforms.mains(id).map(m => `<option${m === selected ? ' selected' : ''}>${esc(m)}</option>`).join('');
    fillSubs();
  }

  // 중분류 목록. 쿠팡은 '중분류 > 소분류'라서 중분류별로 묶어 보여 준다.
  function fillSubs(selected = '') {
    const id = form.elements.platform.value;
    const main = form.elements.catMain.value;
    const list = main ? Platforms.subs(id, main) : [];
    const sel = form.elements.catSub;
    $('#catSubField').hidden = !main || !list.length;
    const opt = s => `<option value="${esc(s.value)}"${s.value === selected ? ' selected' : ''}>${esc(s.name)}${s.rate != null && Platforms.LIST[id].verified ? ` (${s.rate}%)` : ''}</option>`;
    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    sel.innerHTML = `<option value="">${esc(Platforms.otherLabel(id))}</option>`
      + [...groups].map(([group, items]) => (group
        ? `<optgroup label="${esc(group)}">${items.map(opt).join('')}</optgroup>`
        : items.map(opt).join(''))).join('');
  }

  /* ---------- 플랫폼 수수료 ---------- */
  // fill이 false면 안내 문구만 갱신한다 (불러온 값이나 사용자가 고친 값을 덮어쓰지 않도록)
  function applyPlatformFee(fill) {
    const id = form.elements.platform.value;
    const fee = Platforms.feeFor(id, form.elements.catMain.value, form.elements.catSub.value);
    if (fill && fee.rate != null) {
      form.elements.feeRate.value = String(fee.rate);
      liveCalc();
    }
    const note = $('#feeNote');
    note.textContent = id === 'custom'
      ? '판매 플랫폼과 카테고리를 고르면 수수료가 자동으로 들어갑니다. 직접 고칠 수도 있습니다.'
      : fee.note;
    note.classList.toggle('warn', !!fee.estimated);
  }

  function showCatNotice(text) {
    const n = $('#catNotice');
    n.textContent = text;
    n.hidden = !text;
  }

  let lastPlatform = form.elements.platform.value;
  form.elements.platform.addEventListener('change', () => {
    const id = form.elements.platform.value;
    const hadCategory = lastPlatform === 'custom' ? form.elements.catCustom.value.trim() : form.elements.catMain.value;
    lastPlatform = id;
    form.elements.catCustom.value = '';
    fillMains();
    if (id !== 'custom') form.elements.feeRate.value = ''; // 앞 플랫폼의 수수료가 남지 않도록
    showCatNotice(hadCategory
      ? (id === 'custom'
        ? '판매 플랫폼을 직접 입력으로 바꿔 카테고리를 비웠습니다. 카테고리와 수수료를 직접 적어 주세요.'
        : `판매 플랫폼이 ${Platforms.label(id)}(으)로 바뀌어 카테고리를 비웠습니다. 플랫폼마다 카테고리가 달라서 다시 골라 주세요.`)
      : '');
    applyPlatformFee(true);
    liveCalc();
  });
  form.elements.catMain.addEventListener('change', () => { fillSubs(); showCatNotice(''); applyPlatformFee(true); });
  form.elements.catSub.addEventListener('change', () => applyPlatformFee(true));
  fillMains();

  form.addEventListener('input', liveCalc);

  function clearForm() {
    form.reset();
    photos = [];
    docs = [];
    competitors = [];
    renderThumbs();
    renderDocs();
    renderCompetitors();
    $$('.invalid', form).forEach(el => el.classList.remove('invalid'));
    $('#formError').textContent = '';
    lastPlatform = form.elements.platform.value;
    fillMains();
    showCatNotice('');
    applyPlatformFee(false);
  }
  $('#resetForm').addEventListener('click', () => {
    if (!confirm('입력한 내용을 모두 지울까요?')) return;
    clearForm();
    formRecordId = null;
    liveCalc();
  });

  /* ---------- 사진 업로드 ---------- */
  function setupDrop(zone, onFiles) {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag');
      onFiles(e.dataTransfer.files);
    });
  }

  const photoInput = $('#photoInput');
  $('#pickPhoto').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', () => { addPhotos(photoInput.files); photoInput.value = ''; });
  setupDrop($('#dropZone'), addPhotos);

  async function addPhotos(files) {
    const list = [...files].filter(f => f.type.startsWith('image/'));
    for (const file of list) {
      if (photos.length >= MAX_PHOTOS) { alert(`사진은 최대 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`); break; }
      try { photos.push(await shrink(file, 1280)); } catch { alert(`${file.name} 파일을 읽지 못했습니다.`); }
    }
    renderThumbs();
  }

  // 긴 변을 maxSide 이하 JPEG로 줄인다. (AI 전송량·저장 용량 절감)
  function shrink(source, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const src = typeof source === 'string' ? source : URL.createObjectURL(source);
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        if (typeof source !== 'string') URL.revokeObjectURL(src);
        const url = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ mediaType: 'image/jpeg', data: url.split(',')[1], url });
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  function renderThumbs() {
    $('#thumbs').innerHTML = photos.map((p, i) => `
      <div class="thumb"><img src="${p.url}" alt="상품 사진 ${i + 1}">
        <button type="button" data-remove="${i}" aria-label="사진 ${i + 1} 삭제">✕</button></div>`).join('');
  }
  $('#thumbs').addEventListener('click', e => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    photos.splice(Number(b.dataset.remove), 1);
    renderThumbs();
  });

  /* ---------- 경쟁상품 입력 ---------- */
  function renderCompetitors() {
    $('#competitors').innerHTML = competitors.map((c, i) => `
      <div class="comp" data-idx="${i}">
        <div class="comp-head"><b>경쟁상품 ${i + 1}</b>
          <button type="button" class="link-btn danger" data-remove-comp="${i}">삭제</button></div>
        <div class="grid-2">
          <label class="field"><span class="label">상품명</span>
            <input type="text" data-field="name" value="${esc(c.name)}" placeholder="예) A사 원목 트레이" maxlength="80"></label>
          <label class="field"><span class="label">판매가</span>
            <span class="input-unit"><input type="text" inputmode="numeric" data-money data-field="price" value="${esc(c.price)}" placeholder="0"><span class="unit">원</span></span></label>
        </div>
        <label class="field"><span class="label">특징</span>
          <input type="text" data-field="features" value="${esc(c.features)}" placeholder="소재, 크기, 구성, 배송 조건 등" maxlength="500"></label>
        <label class="field"><span class="label">소비자 리뷰 <small class="muted">(여러 개를 줄바꿈으로 구분해 붙여넣기)</small></span>
          <textarea data-field="reviews" rows="3" maxlength="20000" placeholder="예) 생각보다 작아요&#10;마감이 거칠어요">${esc(c.reviews)}</textarea></label>
      </div>`).join('');
    $('#addCompetitor').hidden = competitors.length >= MAX_COMPETITORS;
  }
  $('#addCompetitor').addEventListener('click', () => {
    competitors.push({ name: '', price: '', features: '', reviews: '' });
    renderCompetitors();
    $(`.comp[data-idx="${competitors.length - 1}"] input`).focus();
  });
  $('#competitors').addEventListener('input', e => {
    const box = e.target.closest('.comp');
    if (!box || !e.target.dataset.field) return;
    competitors[Number(box.dataset.idx)][e.target.dataset.field] = e.target.value;
  });
  $('#competitors').addEventListener('click', e => {
    const b = e.target.closest('[data-remove-comp]');
    if (!b) return;
    competitors.splice(Number(b.dataset.removeComp), 1);
    renderCompetitors();
  });

  /* ---------- 자료 업로드 ---------- */
  const docInput = $('#docInput');
  $('#pickDoc').addEventListener('click', () => docInput.click());
  docInput.addEventListener('change', () => { addDocs(docInput.files); docInput.value = ''; });
  setupDrop($('#docDrop'), addDocs);

  // 엑셀에서 저장한 한글 CSV는 EUC-KR인 경우가 많아 UTF-8로 읽히지 않으면 다시 읽는다.
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
      return new TextDecoder('euc-kr').decode(buf);
    }
  }
  function toBase64(buf) {
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function addDocs(files) {
    for (const file of [...files]) {
      if (docs.length >= MAX_DOCS) { alert(`자료는 최대 ${MAX_DOCS}개까지 올릴 수 있습니다.`); break; }
      const ext = file.name.split('.').pop().toLowerCase();
      const buf = await file.arrayBuffer();
      if (ext === 'pdf') {
        if (file.size > MAX_PDF_BYTES) { alert(`${file.name}: PDF는 10MB 이하만 올릴 수 있습니다.`); continue; }
        docs.push({ name: file.name, kind: 'pdf', data: toBase64(buf), size: file.size });
      } else if (ext === 'txt' || ext === 'csv') {
        const text = decodeText(buf).trim();
        if (!text) { alert(`${file.name}: 내용이 비어 있습니다.`); continue; }
        if (text.length > MAX_TEXT_CHARS) { alert(`${file.name}: 글자 수가 너무 많습니다. (최대 ${MAX_TEXT_CHARS.toLocaleString('ko-KR')}자) 파일을 나눠서 올려 주세요.`); continue; }
        docs.push({ name: file.name, kind: 'text', text, size: file.size });
      } else {
        alert(`${file.name}: TXT, CSV, PDF 파일만 올릴 수 있습니다.`);
      }
    }
    renderDocs();
  }
  function renderDocs() {
    $('#docList').innerHTML = docs.map((d, i) => `
      <li><span>${esc(d.name)} <small class="muted">(${(d.size / 1024).toFixed(0)}KB)</small></span>
        <button type="button" class="link-btn danger" data-remove-doc="${i}">삭제</button></li>`).join('');
  }
  $('#docList').addEventListener('click', e => {
    const b = e.target.closest('[data-remove-doc]');
    if (!b) return;
    docs.splice(Number(b.dataset.removeDoc), 1);
    renderDocs();
  });

  /* ---------- AI 설정 ---------- */
  const dlg = $('#settings');
  function showProviderFields() {
    const v = $('input[name="provider"]:checked')?.value;
    $('#qwenSettings').hidden = v !== 'qwen';
    $('#cloudSettings').hidden = v !== 'cloud';
    $('#claudeSettings').hidden = v !== 'claude';
  }
  function updateSettingsButton() {
    const p = AI.getProvider();
    $('#openSettings').textContent = p === 'qwen' ? 'AI 설정 · Qwen' : p === 'cloud' ? 'AI 설정 · 무료 AI' : 'AI 설정';
  }
  $('#cloudOption').hidden = !AI.hasCloud();
  function openSettings() {
    $(`input[name="provider"][value="${AI.getProvider()}"]`).checked = true;
    $('#apiKey').value = AI.getKey();
    $('#rememberKey').checked = AI.isRemembered();
    $('#qwenModel').value = AI.getQwenModel();
    showProviderFields();
    dlg.showModal();
  }
  $('#openSettings').addEventListener('click', openSettings);
  $$('input[name="provider"]').forEach(r => r.addEventListener('change', showProviderFields));
  $('#settingsForm').addEventListener('submit', e => {
    if (e.submitter?.value !== 'save') return;
    AI.setProvider($('input[name="provider"]:checked').value, $('#qwenModel').value);
    AI.setKey($('#apiKey').value.trim(), $('#rememberKey').checked);
    updateSettingsButton();
  });
  dlg.addEventListener('close', () => {
    // AI 없이 본 결과 화면에서 설정을 저장하면 바로 다시 분석한다
    if (dlg.returnValue === 'save' && current && !current.ai && current.id === formRecordId
      && AI.isReady() && !$('#view-result').hidden) form.requestSubmit();
  });

  /* ---------- 로딩 화면과 취소 ---------- */
  // 기다리는 동안 지난 시간, AI가 살펴보는 내용, (분석일 때) 미리 계산한 수익성을 보여 준다.
  const TYPICAL_SEC = 120; // 막대가 채워지는 기준 (보통 1~2분)
  const SLOW_SEC = 180;    // 이보다 오래 걸리면 안내 문구를 보여 준다
  let loadingCtrl = null;
  let loadingTimer = null;
  function startLoading({ tips = [], preview = '' } = {}) {
    loadingCtrl = new AbortController();
    $('#cancelLoading').disabled = false;
    $('#loadingSlow').hidden = true;
    $('#loadingPreview').innerHTML = preview;
    $('#loadingPreview').hidden = !preview;
    const started = Date.now();
    const tick = () => {
      const sec = Math.floor((Date.now() - started) / 1000);
      $('#loadingElapsed').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      // 시간 기준 막대: 실제 진행률이 아니라 보통 걸리는 시간 대비 얼마나 지났는지를 보여 준다
      $('#loadingBar').style.width = `${Math.min(95, (sec / TYPICAL_SEC) * 95)}%`;
      if (tips.length) $('#loadingTip').textContent = `AI가 살펴보는 내용: ${tips[Math.floor(sec / 6) % tips.length]}`;
      $('#loadingSlow').hidden = sec < SLOW_SEC;
    };
    tick();
    clearInterval(loadingTimer);
    loadingTimer = setInterval(tick, 1000);
    $('#loading').hidden = false;
    return loadingCtrl.signal;
  }
  function stopLoading() {
    $('#loading').hidden = true;
    clearInterval(loadingTimer);
    loadingTimer = null;
    loadingCtrl = null;
  }

  // 분석을 기다리는 동안 먼저 보여 줄 수익성 (AI가 아닌 계산값)
  function profitPreview(p, r) {
    const be = Profit.breakEven(p);
    return `<p class="lp-title">기다리는 동안 먼저 확인하세요 <span class="muted">(AI 없이 바로 계산한 값)</span></p>
      <div class="lp-grid">
        <div class="mini"><div class="k">예상 순이익</div><div class="v ${r.profit < 0 ? 'neg' : ''}">${won(r.profit)}</div></div>
        <div class="mini"><div class="k">예상 마진율</div><div class="v ${r.margin < 0 ? 'neg' : ''}">${pct(r.margin)}</div></div>
        <div class="mini"><div class="k">수익성 점수</div><div class="v">${Profit.score(r.margin)}점</div></div>
        <div class="mini"><div class="k">손익분기 판매가</div><div class="v">${be ? won(be) : '계산 불가'}</div></div>
      </div>`;
  }
  const ANALYZE_TIPS = ['상품의 주요 특징과 장단점', '타깃 고객층과 시장성', '경쟁상품 가격·특징·리뷰', '차별화 요소와 판매 위험요소', '종합 점수와 판정 근거'];
  const CONTENT_TIPS = ['상품명 후보', '검색 키워드', '상세페이지 구성안', '홍보문구'];
  $('#cancelLoading').addEventListener('click', () => {
    if (!loadingCtrl) return;
    $('#cancelLoading').disabled = true;
    loadingCtrl.abort(); // 진행 중인 AI 요청을 끊으면 기다리던 작업이 바로 끝난다
  });

  /* ---------- 분석 실행 ---------- */
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const product = readForm();
    const err = validate(product);
    $('#formError').textContent = err;
    if (err) {
      // 오른쪽 요약의 버튼으로 눌렀을 때도 빠진 칸이 보이도록 그 칸으로 이동한다
      const bad = $('.invalid', form);
      if (bad) { bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); bad.focus({ preventScroll: true }); }
      return;
    }

    const profit = Profit.calc(product);
    let ai = null, aiError = null;
    if (AI.isReady()) {
      $('#loadingText').textContent = 'AI가 상품을 분석하고 있습니다';
      const tips = product.competitors.length || product.docs.length ? ANALYZE_TIPS : ANALYZE_TIPS.filter(t => !t.startsWith('경쟁상품'));
      const signal = startLoading({ tips, preview: profitPreview(product, profit) });
      $$('[data-analyze]').forEach(b => { b.disabled = true; });
      try { ai = await AI.analyze(product, profit, signal); } catch (ex) { aiError = { code: ex.code, message: ex.message }; }
      stopLoading();
      $$('[data-analyze]').forEach(b => { b.disabled = false; });
      // 취소하면 저장하지 않고 입력 화면에 그대로 머문다 (입력한 내용은 남아 있음)
      if (signal.aborted) {
        $('#formError').textContent = '분석을 취소했습니다. 내용을 고친 뒤 다시 분석할 수 있습니다.';
        go('input');
        return;
      }
    } else {
      aiError = { code: 'no-key', message: 'AI 설정에서 API 키를 입력하면 상품 분석과 종합 평가를 볼 수 있습니다.' };
    }

    let scores = null, verdict = null;
    if (ai) {
      scores = {
        market: ai.scores.market.score,
        compete: ai.scores.compete.score,
        profit: Profit.score(profit.margin),
        diff: ai.scores.diff.score,
        risk: ai.scores.risk.score,
      };
      verdict = Profit.verdict(scores, profit.margin);
      if (ai.incomplete && verdict.level === 'good') {
        // 점수가 빠진 응답으로는 판매 추천을 내리지 않는다
        verdict = { ...verdict, level: 'warn', label: '추가 검토', reasons: [...verdict.reasons, 'AI 응답에 빠진 점수가 있어 판매 추천 대신 추가 검토로 표시합니다.'] };
      }
    }

    const record = {
      id: `a${Date.now().toString(36)}`,
      savedAt: Date.now(),
      product: {
        name: product.name, category: product.category, catMain: product.catMain, catSub: product.catSub,
        description: product.description,
        material: product.material, size: product.size,
        components: product.components, certification: product.certification,
        cost: product.cost, price: product.price, shipping: product.shipping, packaging: product.packaging,
        feeRate: product.feeRate, platform: product.platform, targetMargin: product.targetMargin,
        competitors: product.competitors,
        docNames: product.docs.map(d => d.name),
        thumb: photos[0] ? (await shrink(photos[0].url, 160)).url : null,
      },
      profit, ai, aiError, scores, verdict,
    };
    record.saved = Store.save(record);
    formRecordId = record.id;
    showRecord(record);
  });

  function showRecord(record) {
    current = record;
    renderResult();
    $('.step[data-go="result"]').disabled = false;
    go('result');
  }

  $('#editProduct').addEventListener('click', () => {
    if (current && current.id !== formRecordId) {
      // 저장된 기록을 불러와 수정: 사진과 업로드 자료는 저장되지 않으므로 다시 올려야 한다
      clearForm();
      const p = current.product;
      for (const k of ['name', 'description', 'targetMargin']) form.elements[k].value = p[k];
      for (const k of ['material', 'size', 'components', 'certification']) form.elements[k].value = p[k] || ''; // 이전에 저장된 기록에는 없을 수 있음
      for (const k of ['cost', 'price', 'shipping', 'packaging']) form.elements[k].value = p[k] ? Number(p[k]).toLocaleString('ko-KR') : '';
      form.elements.feeRate.value = p.feeRate || '';
      // 지금 선택지에 없는 예전 플랫폼(네이버 마케팅 링크 유입)은 네이버 스마트스토어로 불러온다
      const plat = p.platform === 'naverLink' ? 'naver' : p.platform;
      form.elements.platform.value = Platforms.LIST[plat] && !Platforms.LIST[plat].legacyOnly ? plat : 'custom';
      lastPlatform = form.elements.platform.value;
      fillMains();
      if (p.platform === 'naverLink') {
        const keep = p.catMain && Platforms.mains('naver').includes(p.catMain);
        if (keep) form.elements.catMain.value = p.catMain;
        showCatNotice(`예전에 '네이버 마케팅 링크 유입'으로 저장한 분석이라 네이버 스마트스토어로 불러왔습니다.${keep ? '' : ' 카테고리는 다시 골라 주세요.'} 저장했던 수수료(${p.feeRate}%)는 그대로 두었습니다.`);
      } else if (form.elements.platform.value === 'custom') {
        form.elements.catCustom.value = p.catMain || p.category || '';
      } else if (p.catMain && Platforms.mains(p.platform).includes(p.catMain)) {
        form.elements.catMain.value = p.catMain;
        fillSubs(p.catSub || '');
      } else if (p.category) {
        // 예전 기록: 플랫폼별 카테고리가 생기기 전의 카테고리라 새 목록에서 다시 골라야 한다
        showCatNotice(`예전에 저장한 '${p.category}' 카테고리는 새 카테고리 목록에 없어 비워 두었습니다. ${Platforms.label(p.platform)} 카테고리를 다시 골라 주세요. 저장했던 수수료(${p.feeRate}%)는 그대로 두었습니다.`);
      }
      applyPlatformFee(false);
      competitors = p.competitors.map(c => ({ ...c, price: c.price ? Number(c.price).toLocaleString('ko-KR') : '' }));
      renderCompetitors();
      formRecordId = current.id;
      liveCalc();
      if (p.thumb || p.docNames.length) alert('사진과 업로드 자료는 저장되지 않습니다. 필요하면 다시 올려 주세요.');
    }
    go('input');
  });

  /* ---------- 결과 렌더링 ---------- */
  function destroyCharts() {
    charts.forEach(c => c.destroy());
    charts = [];
  }

  function renderResult() {
    const { product, profit, ai, aiError, scores, verdict } = current;
    destroyCharts();
    $('#resName').textContent = product.name;
    $('#resCategory').textContent = `${Platforms.path(product) || '카테고리 없음'} · 분석일 ${date(current.savedAt)}`;

    let html = current.saved === false
      ? '<p class="note small">저장 공간이 부족해 이 분석은 저장되지 않았습니다. 저장된 분석 중 필요 없는 항목을 삭제해 주세요.</p>' : '';
    if (ai) {
      if (ai.notices?.length) html += `<div class="note small"><b>${esc(ai.model)}</b>로 분석한 결과입니다.<ul>${ai.notices.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
      html += verdictCard(verdict, ai);
      html += scoresCard(scores, ai, profit);
    } else {
      html += noAICard(aiError);
    }
    html += profitCard(product, profit, Profit.score(profit.margin));
    html += competitionCard(product, ai);
    if (ai) html += analysisCard(ai) + contentCard(ai.content);

    $('#resultBody').innerHTML = html;
    drawResultCharts(product, scores);
  }

  function noAICard(err) {
    const needKey = ['no-key', 'auth'].includes(err?.code);
    const ollama = ['ollama-offline', 'ollama-model'].includes(err?.code);
    const canRetry = current.id === formRecordId;
    return `<div class="card empty-ai">
      <p><b>${needKey ? 'AI 분석을 하려면 API 키가 필요합니다' : 'AI 분석을 완료하지 못했습니다'}</b></p>
      <p class="muted">${esc(err?.message)}</p>
      <p class="muted small">아래 수익성 분석은 AI 없이 계산된 결과입니다.</p>
      ${needKey ? '<button class="btn-primary" data-action="settings">AI 설정 열기</button>' : ''}
      ${ollama ? '<button class="btn-outline" data-action="settings" style="margin-top:16px">AI 설정 열기</button>' : ''}
      ${!needKey && canRetry ? '<button class="btn-primary" data-action="retry">다시 분석하기</button>' : ''}
    </div>`;
  }
  $('#resultBody').addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'settings') openSettings();
    if (a === 'retry') form.requestSubmit();
    if (a === 'content') makeContent();
    if (a === 'detail') openDetail();
  });

  function verdictCard(v, ai) {
    return `<div class="card" data-box>
      <div class="box-head"><h2>AI 종합 평가</h2>${TOOLS}</div>
      <div class="verdict box-body">
        <div class="verdict-badge ${VERDICT_CLASS[v.level]}">
          <div class="tag">최종 의견</div>
          <div class="word">${v.label}</div>
          <div class="total">종합 ${v.total}점 / 100</div>
        </div>
        <div>
          <p>${ed('summary', ai.summary)}</p>
          <ul>${v.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>
      </div>
      <p class="disclaimer">점수와 의견은 입력된 정보만을 바탕으로 한 <b>참고용 추정치</b>입니다. 실시간 시장 데이터는 반영되지 않았으므로 최종 결정 전 직접 확인해 주세요.<br>
      판정 기준: 순이익 0원 이하 또는 종합 50점 미만·위험도 75점 이상 → 판매 비추천 / 종합 70점 이상·위험도 60점 미만·마진율 15% 이상 → 판매 추천 / 그 외 → 추가 검토</p>
    </div>`;
  }

  function scoresCard(s, ai, profit) {
    const rows = [
      ['시장성', s.market, ai.scores.market.reason],
      ['경쟁력', s.compete, ai.scores.compete.reason],
      ['수익성', s.profit, `${Profit.scoreReason(profit.margin)} (마진율 ${pct(profit.margin)} 기준 자동 계산)`],
      ['차별화 가능성', s.diff, ai.scores.diff.reason],
      ['판매 위험도', s.risk, `${ai.scores.risk.reason} (높을수록 위험)`, true],
    ];
    return `<div class="card">
      <h2>항목별 점수 <small class="muted">(100점 만점, 참고용 추정치)</small></h2>
      <div class="scores">
        <div>${rows.map(([n, v, r, risk]) => `
          <div class="score-row">
            <div class="name">${n}</div>
            <div class="bar"><i class="${risk ? 'risk' : ''}" style="width:${v}%"></i></div>
            <div class="num">${v}</div>
            <div class="score-reason">${badges(r)}</div>
          </div>`).join('')}</div>
        <div class="chart-box"><canvas id="radarChart" aria-label="항목별 점수 레이더 차트"></canvas></div>
      </div>
    </div>`;
  }

  function profitCard(p, r, profitScore) {
    const be = Profit.breakEven(p);
    const rec = Profit.priceForMargin(p, p.targetMargin);
    const rows = Profit.scenarios(p);
    return `<div class="card">
      <h2>판매 수익성 분석 <small class="muted">(1개 판매 기준)</small></h2>
      <div class="kpis">
        <div class="kpi"><div class="k">예상 순이익</div><div class="v ${r.profit < 0 ? 'neg' : 'pos'}">${won(r.profit)}</div></div>
        <div class="kpi"><div class="k">예상 마진율</div><div class="v ${r.margin < 0 ? 'neg' : ''}">${pct(r.margin)}</div></div>
        <div class="kpi"><div class="k">손익분기 판매가</div><div class="v">${be ? won(be) : '계산 불가'}</div></div>
        <div class="kpi"><div class="k">목표 마진 ${p.targetMargin}% 권장가</div><div class="v">${rec ? won(rec) : '계산 불가'}</div></div>
      </div>

      <div class="two-col">
        <div>
          <h3>비용 구성</h3>
          <div class="table-wrap"><table>
            <tbody>
              <tr><td>판매가</td><td>${won(p.price)}</td></tr>
              <tr><td>상품 원가</td><td>− ${won(p.cost)}</td></tr>
              <tr><td>배송비</td><td>− ${won(p.shipping)}</td></tr>
              <tr><td>포장비</td><td>− ${won(p.packaging)}</td></tr>
              <tr><td>플랫폼 수수료 (${p.platform && p.platform !== 'custom' ? `${esc(Platforms.shortLabel(p.platform, !p.catMain))} · ` : ''}${p.feeRate}%)</td><td>− ${won(r.fee)}</td></tr>
              <tr class="current"><td>순이익</td><td>${won(r.profit)}</td></tr>
            </tbody>
          </table></div>
        </div>
        <div>
          <h3>비용 비중</h3>
          <div class="chart-box" style="height:220px"><canvas id="costChart" aria-label="비용 구성 차트"></canvas></div>
        </div>
      </div>

      <h3 style="margin-top:24px">판매가격별 수익 비교</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>구분</th><th>판매가</th><th>수수료</th><th>순이익</th><th>마진율</th></tr></thead>
        <tbody>${rows.map(x => `
          <tr class="${x.kind}"><td>${x.label}</td><td>${won(x.price)}</td><td>${won(x.fee)}</td>
          <td class="${x.profit < 0 ? 'neg' : ''}">${won(x.profit)}</td><td>${pct(x.margin)}</td></tr>`).join('')}
        </tbody>
      </table></div>
      <div class="chart-box" style="margin-top:16px"><canvas id="priceChart" aria-label="판매가격별 순이익 차트"></canvas></div>
      <p class="disclaimer">수익성 점수 ${profitScore}점: 마진율 0% = 20점, 40% 이상 = 100점으로 환산한 값입니다. 광고비, 반품·교환 비용, 부가세 등은 포함되지 않았습니다.</p>
    </div>`;
  }

  function competitionCard(product, ai) {
    const comps = product.competitors;
    const hasInput = comps.length > 0 || product.docNames.length > 0;
    if (!hasInput) {
      return `<div class="card">
        <h2>경쟁상품 분석</h2>
        <p class="muted">입력된 경쟁상품 정보가 없습니다. 상품 입력 화면에서 경쟁상품 가격·특징·리뷰를 입력하거나 자료를 올리면 비교 분석 결과가 여기에 표시됩니다.</p>
      </div>`;
    }
    const st = Profit.competitorStats(product);
    const c = ai?.competition;
    let html = `<div class="card"><h2>경쟁상품 분석 <small class="muted">(직접 입력한 정보 기준)</small></h2>`;

    if (st) {
      html += `<div class="kpis">
        <div class="kpi"><div class="k">경쟁상품 평균가 (${st.count}개)</div><div class="v">${won(st.avg)}</div></div>
        <div class="kpi"><div class="k">경쟁 가격 범위</div><div class="v" style="font-size:16px">${won(st.min)} ~ ${won(st.max)}</div></div>
        <div class="kpi"><div class="k">내 판매가 (평균 대비)</div><div class="v">${st.diffPct >= 0 ? '+' : ''}${pct(st.diffPct)}</div></div>
        <div class="kpi"><div class="k">평균가로 팔 때 순이익</div><div class="v ${st.atAvg.profit < 0 ? 'neg' : ''}">${won(st.atAvg.profit)}</div></div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <div class="table-wrap"><table>
          <thead><tr><th>상품</th><th>판매가</th><th>내 가격 대비</th></tr></thead>
          <tbody>
            <tr class="current"><td>내 상품</td><td>${won(product.price)}</td><td>-</td></tr>
            ${comps.map(x => `<tr><td>${esc(x.name || '(이름 없음)')}</td><td>${x.price > 0 ? won(x.price) : '-'}</td>
              <td>${x.price > 0 ? `${x.price >= product.price ? '+' : ''}${pct((x.price - product.price) / product.price * 100)}` : '-'}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <div class="chart-box" style="height:${Math.max(160, 44 * (st.count + 1))}px"><canvas id="compChart" aria-label="경쟁상품 가격 비교 차트"></canvas></div>
      </div>`;
    }

    if (!c) {
      html += '<p class="muted">경쟁상품 장단점과 리뷰 분석은 AI 분석이 완료되면 표시됩니다.</p></div>';
      return html;
    }
    const positives = c.review_positives || []; // 이전에 저장된 기록에는 없음
    html += `<div class="boxes">`;
    html += box('경쟁력 평가', `<p>${ed('competition.position', c.position)}</p>`);
    if (c.items.length) {
      html += box('경쟁상품 장단점', `<div class="table-wrap"><table class="pros-cons">
          <thead><tr><th>상품</th><th>장점</th><th>단점</th></tr></thead>
          <tbody>${c.items.map((it, i) => `<tr><td><b>${esc(it.name)}</b></td>
            <td>${listInline(it.strengths, `competition.items.${i}.strengths`)}</td>
            <td>${listInline(it.weaknesses, `competition.items.${i}.weaknesses`)}</td></tr>`).join('')}</tbody>
        </table></div>`);
    }
    const noReview = '<p class="muted">분석할 리뷰가 입력되지 않았습니다.</p>';
    html += box('리뷰에서 찾은 만족 요인', positives.length
      ? `<ul class="list-plain">${positives.map((r, i) => `<li><span class="pill pill-good">만족</span><b>${ed(`competition.review_positives.${i}.point`, r.point)}</b>
          <div class="sub">근거: ${ed(`competition.review_positives.${i}.evidence`, r.evidence)}</div></li>`).join('')}</ul>`
      : noReview);
    html += box('리뷰에서 찾은 불만사항과 개선점', c.review_insights.length
      ? `<ul class="list-plain">${c.review_insights.map((r, i) => `<li><span class="pill">불만</span><b>${ed(`competition.review_insights.${i}.complaint`, r.complaint)}</b>
          <div class="sub">근거: ${ed(`competition.review_insights.${i}.evidence`, r.evidence)}</div>
          <div class="sub"><span class="pill">개선</span>${ed(`competition.review_insights.${i}.improvement`, r.improvement)}</div></li>`).join('')}</ul>`
      : noReview);
    html += '</div>';
    if (product.docNames.length) html += `<p class="disclaimer">참고한 업로드 자료: ${product.docNames.map(esc).join(', ')}</p>`;
    return html + '</div>';
  }

  function listInline(items, base) {
    return items.length ? items.map((t, i) => `· ${ed(`${base}.${i}`, t)}`).join('<br>') : '<span class="muted">-</span>';
  }
  function list(items, base) {
    return items?.length ? `<ul>${items.map((t, i) => `<li>${ed(`${base}.${i}`, t)}</li>`).join('')}</ul>` : '<p class="muted">해당 없음</p>';
  }

  function analysisCard(ai) {
    const points = ai.selling_points || []; // 이전에 저장된 기록에는 없음
    return `<div class="card">
      <h2>AI 상품 분석</h2>
      <div class="boxes">
      ${box('주요 특징', list(ai.features, 'features'))}
      <div class="two-col">
        ${box('장점', list(ai.strengths, 'strengths'))}
        ${box('단점', list(ai.weaknesses, 'weaknesses'))}
      </div>
      ${box('강조할 장점과 근거', points.length
        ? `<ul class="list-plain">${points.map((x, i) => `<li><b>${ed(`selling_points.${i}.point`, x.point)}</b>
            <div class="sub">근거: ${ed(`selling_points.${i}.evidence`, x.evidence)}</div></li>`).join('')}</ul>`
        : '<p class="muted">해당 없음</p>')}
      ${box('예상 타깃 고객층', `<ul class="list-plain">${ai.targets.map((t, i) => `<li><b>${ed(`targets.${i}.segment`, t.segment)}</b>
          <div class="sub">${ed(`targets.${i}.reason`, t.reason)}</div></li>`).join('')}</ul>`)}
      ${box('시장성과 판매 가능성', `<p>${ed('marketability', ai.marketability)}</p>`)}
      ${box('차별화 요소 제안', list(ai.differentiation, 'differentiation'))}
      ${box('예상 위험요소와 개선 방향', `<ul class="list-plain">${ai.risks.map((r, i) => `<li><span class="pill">위험</span>${ed(`risks.${i}.risk`, r.risk)}
          <div class="sub"><span class="pill">개선</span>${ed(`risks.${i}.improvement`, r.improvement)}</div></li>`).join('')}</ul>`)}
      ${ai.missing_info?.length ? box('더 정확한 분석을 위해 필요한 정보', list(ai.missing_info, 'missing_info')) : ''}
      </div>
      <p class="disclaimer"><mark class="general">일반 정보</mark> 표시는 입력한 정보가 아니라 이 상품군에 대해 AI가 알고 있는 일반적인 내용입니다. 이 상품에 그대로 해당하는지는 직접 판단해 주세요.<br>
      <mark class="verify">확인 필요</mark> 표시는 이 상품에 대한 내용이지만 입력한 자료로 확인되지 않은 것입니다. 판매 전에 사실인지 직접 확인해 주세요. 각 항목의 <b>수정</b> 버튼으로 문구를 고칠 수 있고, 고친 내용은 저장된 분석에도 반영됩니다.<br>
      AI 분석은 입력한 상품 정보, 사진, 경쟁상품 정보와 업로드 자료만을 근거로 작성되었으며 실시간 시장 데이터를 조회하지 않았습니다. (모델: ${esc(ai.model || AI.MODEL)})</p>
    </div>`;
  }

  /* ---------- 판매 콘텐츠 ---------- */
  function contentCard(c) {
    if (!c) {
      return `<div class="card empty-ai content-empty">
        <p><b>판매 콘텐츠 만들기</b></p>
        <p class="muted">위 분석 결과를 바탕으로 상품명 후보, 검색 키워드, 상세페이지 구성안, 홍보문구 초안을 만듭니다.<br>
        분석 결과를 수정했다면 고친 내용이 반영됩니다. 먼저 분석 결과를 확인하고 필요한 부분을 고친 뒤 만드는 것을 권장합니다.</p>
        <button class="btn-primary" data-action="content">판매 콘텐츠 만들기</button>
      </div>`;
    }
    // 수정 후 경고가 새로 생길 수 있어 경고 칸은 항상 두고 비어 있으면 숨긴다
    const notes = `<div class="note small content-note" ${c.notices.length ? '' : 'hidden'}>${c.notices.map(esc).join('<br>')}</div>`;
    return `<div class="card" id="contentCard">
      <div class="box-head"><h2>판매 콘텐츠 초안</h2>
        <div class="head-actions"><button class="btn-outline" data-action="content">다시 만들기</button>
        <button class="btn-primary" data-action="detail">상세페이지 만들기</button></div></div>
      ${notes}
      <div class="boxes">
      ${box('상품명 후보', `<ul class="list-plain">${c.product_names.map((x, i) => `<li><b>${ed(`content.product_names.${i}.name`, x.name)}</b>
          <div class="sub">${ed(`content.product_names.${i}.reason`, x.reason)}</div></li>`).join('')}</ul>`)}
      ${box('검색 키워드', `<p class="keywords">${c.keywords.map((k, i) => ed(`content.keywords.${i}`, k)).join('<span class="sep">, </span>')}</p>
          <p class="muted small">AI가 제안한 후보입니다. 실제 검색량은 확인되지 않았으니 네이버 데이터랩 등에서 직접 확인해 주세요.</p>`)}
      ${box('상세페이지 구성안 (위에서 아래 순서)', `<ol class="detail-list">${c.detail_page.map((x, i) => `<li><b>${esc(x.section)}</b>
          <div>${ed(`content.detail_page.${i}.content`, x.content)}</div>
          <div class="sub">근거: ${ed(`content.detail_page.${i}.evidence`, x.evidence)}</div></li>`).join('')}</ol>`)}
      ${box('홍보문구', `<ul class="list-plain">${c.promo_copies.map((x, i) => `<li><span class="pill">${esc(x.channel)}</span>
          <div class="promo">${ed(`content.promo_copies.${i}.text`, x.text)}</div></li>`).join('')}</ul>`)}
      </div>
      <p class="disclaimer">AI가 만든 <b>초안</b>입니다. 상품의 사실과 다르거나 과장된 표현이 없는지 확인한 뒤 사용해 주세요. 각 항목의 <b>수정</b> 버튼으로 고칠 수 있습니다. (모델: ${esc(c.model)})</p>
    </div>`;
  }

  async function makeContent() {
    if (!current?.ai) return;
    if (!AI.isReady()) { openSettings(); return; }
    // 저장된 분석에는 사진·자료 원본이 없으므로 글 정보만으로 만든다
    const product = { ...current.product, photos: [], docs: [] };
    $('#loadingText').textContent = 'AI가 판매 콘텐츠를 만들고 있습니다';
    const signal = startLoading({ tips: CONTENT_TIPS });
    try {
      current.ai.content = await AI.generateContent(product, current.profit, current.ai, signal);
      delete current.ai.detailPage; // 새 콘텐츠로 상세페이지를 다시 만든다
      current.saved = Store.save(current);
      renderResult();
      $('#contentCard')?.scrollIntoView({ block: 'start' });
    } catch (ex) {
      if (!signal.aborted) alert(`판매 콘텐츠를 만들지 못했습니다.\n${ex.message}`);
    } finally {
      stopLoading();
    }
  }

  /* ---------- 상세페이지 만들기 ---------- */
  // 문구와 색상은 분석 기록에 저장하고, 사진은 용량 때문에 이번 화면에서만 쓴다.
  let detailPhotos = [null, null, null];
  let detailPhotosFor = null; // 어느 기록의 사진인지

  function openDetail() {
    if (!current?.ai?.content) return;
    if (!current.ai.detailPage) {
      current.ai.detailPage = DetailPage.buildModel(current.product, current.ai.content, current.ai);
      current.saved = Store.save(current);
    }
    if (detailPhotosFor !== current.id) {
      // 방금 분석한 상품이면 입력 화면에 올린 사진을 그대로 쓴다
      detailPhotos = current.id === formRecordId ? [0, 1, 2].map(i => photos[i] || null) : [null, null, null];
      detailPhotosFor = current.id;
    }
    renderDetailPanel();
    renderDetailPreview();
    go('detail');
  }

  function renderDetailPanel() {
    const m = current.ai.detailPage;
    $('#dpThemes').innerHTML = Object.entries(DetailPage.THEMES).map(([id, t]) =>
      `<button type="button" class="dp-theme ${m.theme === id ? 'is-active' : ''}" data-theme="${id}"><i style="background:${t.main}"></i>${t.label}</button>`).join('');
    $('#dpSlots').innerHTML = DetailPage.SLOT_LABELS.map((label, i) => {
      const p = detailPhotos[i];
      return `<div class="dp-slot"><span class="thumb-s" style="${p ? `background-image:url(${p.url})` : ''}"></span>
        <span class="name">${label}</span>
        <input type="file" accept="image/*" hidden data-slot-input="${i}">
        <button type="button" class="link-btn" data-slot-pick="${i}">${p ? '변경' : '올리기'}</button>
        ${p ? `<button type="button" class="link-btn danger" data-slot-clear="${i}">빼기</button>` : ''}</div>`;
    }).join('');
    $('#dpPhotoNote').textContent = '사진은 저장되지 않습니다. 저장된 분석을 다시 열면 사진을 다시 올려 주세요. 사진이 없는 칸은 이미지에서 빠집니다.';
  }
  function renderDetailPreview() {
    $('#dpPreview').innerHTML = DetailPage.render(current.ai.detailPage, detailPhotos);
  }

  $('#dpThemes').addEventListener('click', e => {
    const id = e.target.closest('[data-theme]')?.dataset.theme;
    if (!id) return;
    current.ai.detailPage.theme = id;
    current.saved = Store.save(current);
    renderDetailPanel();
    renderDetailPreview();
  });
  $('#dpSlots').addEventListener('click', e => {
    const pick = e.target.closest('[data-slot-pick]')?.dataset.slotPick;
    const clear = e.target.closest('[data-slot-clear]')?.dataset.slotClear;
    if (pick != null) $(`[data-slot-input="${pick}"]`).click();
    if (clear != null) { detailPhotos[Number(clear)] = null; renderDetailPanel(); renderDetailPreview(); }
  });
  $('#dpSlots').addEventListener('change', async e => {
    const i = e.target.dataset.slotInput;
    const file = e.target.files?.[0];
    if (i == null || !file) return;
    try { detailPhotos[Number(i)] = await shrink(file, 1720); } catch { alert(`${file.name} 파일을 읽지 못했습니다.`); }
    renderDetailPanel();
    renderDetailPreview();
  });
  // 미리보기에서 고친 글자를 입력하는 대로 저장한다 (저장은 잠깐 멈췄을 때 한 번)
  let detailSaveTimer = null;
  function saveDetailText(el) {
    DetailPage.setPath(current.ai.detailPage, el.dataset.dp, DetailPage.readText(el));
    clearTimeout(detailSaveTimer);
    detailSaveTimer = setTimeout(() => { current.saved = Store.save(current); }, 400);
  }
  $('#dpPreview').addEventListener('input', e => {
    const el = e.target.closest('[data-dp]');
    if (el) saveDetailText(el);
  });
  $('#dpPreview').addEventListener('focusout', e => {
    const el = e.target.closest('[data-dp]');
    if (el) saveDetailText(el);
  });
  $('#dpPreview').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('[data-dp]')) { e.preventDefault(); e.target.blur(); }
  });
  $('#detailBack').addEventListener('click', () => { renderResult(); go('result'); });

  $('#detailDownload').addEventListener('click', async () => {
    document.activeElement?.blur(); // 편집 중인 글자를 먼저 저장
    const m = current.ai.detailPage;
    const c = DetailPage.check(m, detailPhotos, current.product);
    const warn = [];
    if (c.verify) warn.push(`· '확인 필요' 표시가 붙은 문장이 ${c.verify}개 있습니다. 사실인지 확인하고 표시를 지워 주세요. (이미지에는 표시 없이 문장만 들어갑니다)`);
    if (c.risky.length) warn.push(`· 과장되거나 광고 규정상 문제가 될 수 있는 표현: ${c.risky.map(w => `'${w}'`).join(', ')}`);
    if (c.emptyPhotos.length) warn.push(`· 사진이 없는 칸(${c.emptyPhotos.join(', ')})은 이미지에서 빠집니다.`);
    if (warn.length && !confirm(`내려받기 전에 확인해 주세요.\n\n${warn.join('\n')}\n\n그래도 내려받을까요?`)) return;
    const btn = $('#detailDownload');
    btn.disabled = true;
    btn.textContent = '이미지 만드는 중...';
    const safeName = current.product.name.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '상품';
    try {
      await DetailPage.exportPng($('#dpPreview .dp'), `상세페이지_${safeName}.png`);
    } catch (ex) {
      alert(`이미지를 만들지 못했습니다.\n${ex.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '이미지 내려받기';
    }
  });

  /* ---------- 결과 문구 수정·복사 ---------- */
  // AI가 쓴 문장마다 data-path로 원래 값의 위치를 기억해 두고, 수정을 마치면 분석 기록에 반영해 저장한다.
  const VERIFY_RE = /\s*[[(]확인 ?필요[\])]/g;
  const GENERAL_RE = /\s*[[(]일반 ?정보[\])]/g;
  const TOOLS = '<div class="box-tools"><button type="button" class="link-btn" data-edit>수정</button><button type="button" class="link-btn" data-copy>복사</button></div>';
  function badges(text) {
    if (/^\s*[[(]?확인 ?필요[\])]?\s*$/.test(text)) return '<mark class="verify">확인 필요</mark>'; // 근거 칸에 '확인 필요'만 적힌 경우
    return esc(text).replace(/\s*[[(]입력 ?정보[\])]/g, '') // 입력 정보는 표시 없이 쓰라고 했지만 작은 모델이 붙이는 경우가 있음
      .replace(VERIFY_RE, ' <mark class="verify">확인 필요</mark>')
      .replace(GENERAL_RE, ' <mark class="general">일반 정보</mark>');
  }
  function ed(path, text) {
    return `<span class="ed" data-path="${path}">${badges(text)}</span>`;
  }
  function box(title, body) {
    return `<div class="box" data-box><div class="box-head"><h3>${title}</h3>${TOOLS}</div><div class="box-body">${body}</div></div>`;
  }
  // 편집 중인 문장에서 '확인 필요'·'일반 정보' 표시를 원래 [ ] 글자로 되돌려 읽는다
  function readEdited(span) {
    const clone = span.cloneNode(true);
    clone.querySelectorAll('mark.verify').forEach(m => m.replaceWith(' [확인 필요]'));
    clone.querySelectorAll('mark.general').forEach(m => m.replaceWith(' [일반 정보]'));
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o == null ? o : o[k]), obj);
    if (target != null) target[last] = value;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }
  function flash(btn, text) {
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 1500);
  }

  $('#resultBody').addEventListener('click', async e => {
    const editBtn = e.target.closest('[data-edit]');
    const copyBtn = e.target.closest('[data-copy]');
    if (!editBtn && !copyBtn) return;
    const boxEl = e.target.closest('[data-box]');
    if (editBtn) {
      const editing = boxEl.classList.toggle('editing');
      const spans = [...boxEl.querySelectorAll('.ed')];
      spans.forEach(s => { s.contentEditable = editing ? 'true' : 'false'; });
      editBtn.textContent = editing ? '완료' : '수정';
      if (editing) { spans[0]?.focus(); return; }
      for (const s of spans) {
        const value = readEdited(s);
        setPath(current.ai, s.dataset.path, value);
        s.outerHTML = ed(s.dataset.path, value);
      }
      // 판매 콘텐츠를 고쳤으면 과장 표현 경고를 고친 문구 기준으로 다시 계산한다
      const content = current.ai.content;
      const noteEl = boxEl.closest('#contentCard')?.querySelector('.content-note');
      if (content && noteEl) {
        content.notices = [...content.notices.filter(n => !n.startsWith('과장되거나')), ...AI.riskyWordNotices(content, current.product)];
        noteEl.innerHTML = content.notices.map(esc).join('<br>');
        noteEl.hidden = !content.notices.length;
      }
      current.saved = Store.save(current);
      flash(editBtn, current.saved ? '저장됨' : '저장 실패');
      return;
    }
    const title = boxEl.querySelector('.box-head h2, .box-head h3')?.textContent.trim() || '';
    const body = boxEl.querySelector('.box-body').innerText.trim();
    flash(copyBtn, (await copyText(`${title}\n${body}`)) ? '복사됨' : '복사 실패');
  });
  // 한 문장 칸 안에서 Enter로 줄이 나뉘지 않게 한다
  $('#resultBody').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest?.('.ed[contenteditable="true"]')) e.preventDefault();
  });

  /* ---------- 차트 ---------- */
  const ACCENT = '#ef7a32';
  const SERIES = ['#ef7a32', '#0d9488', '#7c3aed', '#7c2d12', '#db2777'];
  function chartDefaults() {
    if (!window.Chart) return false; // 차트 라이브러리를 못 불러와도 표는 보인다
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = '#6b7280';
    return true;
  }
  const wonAxis = { ticks: { callback: v => `${Number(v).toLocaleString('ko-KR')}원` }, grid: { color: '#f1f5f9' } };

  function drawResultCharts(p, scores) {
    if (!chartDefaults()) return;

    if (scores) {
      charts.push(new Chart($('#radarChart'), {
        type: 'radar',
        data: {
          labels: ['시장성', '경쟁력', '수익성', '차별화', '안정성(100−위험도)'],
          datasets: [{
            data: [scores.market, scores.compete, scores.profit, scores.diff, 100 - scores.risk],
            backgroundColor: 'rgba(239,122,50,.14)', borderColor: ACCENT, pointBackgroundColor: ACCENT, borderWidth: 2,
          }],
        },
        options: {
          maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: 'transparent' }, grid: { color: '#e5e7eb' }, angleLines: { color: '#e5e7eb' } } },
        },
      }));
    }

    const r = Profit.calc(p);
    const parts = [['상품 원가', p.cost], ['배송비', p.shipping], ['포장비', p.packaging], ['수수료', r.fee], ['순이익', Math.max(0, r.profit)]]
      .filter(([, v]) => v > 0);
    const costColors = { '상품 원가': '#9a4a17', '배송비': '#ef7a32', '포장비': '#fdba74', '수수료': '#fde3c8', '순이익': '#15803d' };
    charts.push(new Chart($('#costChart'), {
      type: 'doughnut',
      data: {
        labels: parts.map(x => x[0]),
        datasets: [{ data: parts.map(x => Math.round(x[1])), backgroundColor: parts.map(x => costColors[x[0]]), borderWidth: 0 }],
      },
      options: {
        maintainAspectRatio: false, cutout: '62%', animation: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10 } },
          tooltip: { callbacks: { label: c => ` ${c.label}: ${won(c.raw)}` } },
        },
      },
    }));

    const rows = Profit.scenarios(p);
    charts.push(new Chart($('#priceChart'), {
      type: 'bar',
      data: {
        labels: rows.map(x => won(x.price)),
        datasets: [{
          label: '순이익',
          data: rows.map(x => Math.round(x.profit)),
          backgroundColor: rows.map(x => x.profit < 0 ? '#b91c1c' : x.kind === 'current' ? ACCENT : x.kind === 'recommend' ? '#15803d' : '#cbd5e1'),
          borderRadius: 4,
        }],
      },
      options: {
        maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: c => rows[c[0].dataIndex].label, label: c => ` 순이익 ${won(c.raw)} (마진율 ${pct(rows[c.dataIndex].margin)})` } },
        },
        scales: { y: wonAxis, x: { grid: { display: false } } },
      },
    }));

    const compCanvas = $('#compChart');
    if (compCanvas) {
      const priced = [{ name: '내 상품', price: p.price, mine: true }, ...p.competitors.filter(c => c.price > 0)];
      charts.push(new Chart(compCanvas, {
        type: 'bar',
        data: {
          labels: priced.map(c => c.name || '(이름 없음)'),
          datasets: [{ data: priced.map(c => c.price), backgroundColor: priced.map(c => c.mine ? ACCENT : '#cbd5e1'), borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y', maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${won(c.raw)}` } } },
          scales: { x: wonAxis, y: { grid: { display: false } } },
        },
      }));
    }
  }

  /* ---------- 저장된 분석 ---------- */
  const selected = new Set();

  function verdictTag(r) {
    if (!r.verdict) return '<span class="tag-v" style="background:var(--subtle);color:var(--muted)">AI 미분석</span>';
    return `<span class="tag-v ${VERDICT_CLASS[r.verdict.level]}">${r.verdict.label}</span>`;
  }

  const MAX_COMPARE = 5;
  // 선택 개수에 맞춰 버튼 상태를 바꾼다. 삭제는 몇 개든 가능하고, 비교는 2~5개일 때만 가능하다.
  function updateSavedButtons() {
    const total = Store.all().length;
    const n = selected.size;
    $('#deleteSelectedBtn').disabled = n === 0;
    $('#deleteSelectedBtn').textContent = n ? `선택 삭제 (${n})` : '선택 삭제';
    $('#deleteAllBtn').disabled = total === 0;
    $('#compareBtn').disabled = n < 2 || n > MAX_COMPARE;
    $('#compareBtn').textContent = n > MAX_COMPARE ? `비교는 최대 ${MAX_COMPARE}개` : '선택한 상품 비교';
    const all = $('#selectAll');
    if (all) {
      all.checked = total > 0 && n === total;
      all.indeterminate = n > 0 && n < total;
    }
  }

  function deleteRecords(ids) {
    Store.removeMany(ids);
    ids.forEach(id => selected.delete(id));
    if (current && ids.includes(current.id)) { current = null; $('.step[data-go="result"]').disabled = true; }
    renderSaved();
  }

  $('#deleteSelectedBtn').addEventListener('click', () => {
    const ids = [...selected];
    if (!ids.length) return;
    const names = Store.all().filter(r => selected.has(r.id)).map(r => r.product.name);
    const preview = names.slice(0, 5).map(n => `· ${n}`).join('\n') + (names.length > 5 ? `\n외 ${names.length - 5}개` : '');
    if (!confirm(`선택한 분석 ${ids.length}개를 삭제할까요? 삭제하면 되돌릴 수 없습니다.\n\n${preview}`)) return;
    deleteRecords(ids);
  });
  $('#deleteAllBtn').addEventListener('click', () => {
    const list = Store.all();
    if (!list.length) return;
    if (!confirm(`저장된 분석 ${list.length}개를 모두 삭제할까요? 삭제하면 되돌릴 수 없습니다.`)) return;
    deleteRecords(list.map(r => r.id));
  });

  function renderSaved() {
    const list = Store.all();
    for (const id of [...selected]) if (!list.some(r => r.id === id)) selected.delete(id);
    updateSavedButtons();
    if (!list.length) {
      $('#savedBody').innerHTML = `<div class="card empty-ai"><p><b>아직 저장된 분석이 없습니다</b></p>
        <p class="muted">상품을 분석하면 결과가 자동으로 이곳에 저장됩니다.</p>
        <button class="btn-primary" data-go="input">상품 분석하러 가기</button></div>`;
      return;
    }
    $('#savedBody').innerHTML = `<div class="card"><div class="table-wrap"><table class="saved-table">
      <thead><tr><th class="sel"><input type="checkbox" id="selectAll" aria-label="전체 선택"></th><th>상품</th><th>판정</th><th>종합 점수</th><th>마진율</th><th>순이익</th><th>분석일</th><th></th></tr></thead>
      <tbody>${list.map(r => `<tr class="${selected.has(r.id) ? 'is-selected' : ''}">
        <td class="sel"><input type="checkbox" data-select="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="${esc(r.product.name)} 선택"></td>
        <td><div class="saved-name">${r.product.thumb ? `<img src="${r.product.thumb}" alt="">` : '<span class="noimg"></span>'}
          <div><b>${esc(r.product.name)}</b><div class="muted small">${esc(Platforms.path(r.product))}</div></div></div></td>
        <td>${verdictTag(r)}</td>
        <td>${r.verdict ? `${r.verdict.total}점` : '-'}</td>
        <td class="${r.profit.margin < 0 ? 'neg' : ''}">${pct(r.profit.margin)}</td>
        <td class="${r.profit.profit < 0 ? 'neg' : ''}">${won(r.profit.profit)}</td>
        <td>${date(r.savedAt)}</td>
        <td><button class="link-btn" data-open="${r.id}">보기</button><button class="link-btn danger" data-delete="${r.id}">삭제</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div>
    <p class="muted small">분석 결과는 이 브라우저에만 저장됩니다. 브라우저 기록을 삭제하면 함께 지워질 수 있으니 중요한 결과는 PDF로 내려받아 두세요.</p>`;
    updateSavedButtons();
  }

  $('#savedBody').addEventListener('change', e => {
    if (e.target.id === 'selectAll') {
      const on = e.target.checked;
      $$('[data-select]', $('#savedBody')).forEach(cb => {
        cb.checked = on;
        cb.closest('tr').classList.toggle('is-selected', on);
        if (on) selected.add(cb.dataset.select); else selected.delete(cb.dataset.select);
      });
      updateSavedButtons();
      return;
    }
    const id = e.target.dataset.select;
    if (!id) return;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    e.target.closest('tr').classList.toggle('is-selected', e.target.checked);
    updateSavedButtons();
  });
  $('#savedBody').addEventListener('click', e => {
    const open = e.target.closest('[data-open]')?.dataset.open;
    const del = e.target.closest('[data-delete]')?.dataset.delete;
    if (open) { const r = Store.get(open); if (r) showRecord(r); }
    if (del) {
      const r = Store.get(del);
      if (!r || !confirm(`'${r.product.name}' 분석 결과를 삭제할까요? 삭제하면 되돌릴 수 없습니다.`)) return;
      deleteRecords([del]);
    }
  });

  /* ---------- 상품 비교 ---------- */
  $('#compareBtn').addEventListener('click', () => {
    const records = Store.all().filter(r => selected.has(r.id));
    if (records.length < 2) return;
    renderCompare(records);
    go('compare');
  });

  function renderCompare(records) {
    destroyCharts();
    const metrics = [
      ['최종 의견', r => r.verdict?.label ?? 'AI 미분석', null],
      ['종합 점수', r => r.verdict?.total, 'high'],
      ['시장성', r => r.scores?.market, 'high'],
      ['경쟁력', r => r.scores?.compete, 'high'],
      ['수익성', r => r.scores?.profit ?? Profit.score(r.profit.margin), 'high'],
      ['차별화 가능성', r => r.scores?.diff, 'high'],
      ['판매 위험도 (낮을수록 좋음)', r => r.scores?.risk, 'low'],
      ['판매가', r => r.product.price, null, won],
      ['예상 순이익', r => r.profit.profit, 'high', won],
      ['예상 마진율', r => r.profit.margin, 'high', pct],
    ];
    const rows = metrics.map(([label, get, better, fmt]) => {
      const vals = records.map(get);
      const nums = vals.filter(v => typeof v === 'number');
      const best = better && nums.length > 1 ? (better === 'high' ? Math.max(...nums) : Math.min(...nums)) : null;
      return `<tr><td>${label}</td>${vals.map(v => `<td class="${v === best ? 'best' : ''}">${v == null ? '-' : fmt ? fmt(v) : typeof v === 'number' ? `${v}점` : esc(v)}</td>`).join('')}</tr>`;
    }).join('');

    const withScores = records.filter(r => r.scores);
    $('#compareBody').innerHTML = `
      <div class="card">
        <h2>점수·수익 비교표</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>항목</th>${records.map(r => `<th>${esc(r.product.name)}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="disclaimer">초록색 굵은 글씨는 해당 항목에서 가장 좋은 값입니다. 점수는 각 상품의 입력 정보에 기반한 참고용 추정치로, 입력 정보의 양과 질이 다르면 직접 비교에 한계가 있습니다.</p>
      </div>
      <div class="two-col">
        <div class="card"><h2>항목별 점수</h2>
          ${withScores.length ? '<div class="chart-box"><canvas id="cmpScoreChart" aria-label="상품별 항목 점수 비교 차트"></canvas></div>' : '<p class="muted">AI 분석이 완료된 상품이 없습니다.</p>'}
        </div>
        <div class="card"><h2>예상 마진율</h2>
          <div class="chart-box"><canvas id="cmpMarginChart" aria-label="상품별 마진율 비교 차트"></canvas></div>
        </div>
      </div>`;

    if (!chartDefaults()) return;
    if (withScores.length) {
      charts.push(new Chart($('#cmpScoreChart'), {
        type: 'bar',
        data: {
          labels: ['시장성', '경쟁력', '수익성', '차별화', '안정성'],
          datasets: withScores.map((r, i) => ({
            label: r.product.name,
            data: [r.scores.market, r.scores.compete, r.scores.profit, r.scores.diff, 100 - r.scores.risk],
            backgroundColor: SERIES[i % SERIES.length], borderRadius: 3,
          })),
        },
        options: {
          maintainAspectRatio: false, animation: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
          scales: { y: { min: 0, max: 100, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } },
        },
      }));
    }
    charts.push(new Chart($('#cmpMarginChart'), {
      type: 'bar',
      data: {
        labels: records.map(r => r.product.name),
        datasets: [{ data: records.map(r => +r.profit.margin.toFixed(1)), backgroundColor: records.map(r => r.profit.margin < 0 ? '#b91c1c' : ACCENT), borderRadius: 4 }],
      },
      options: {
        maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` 마진율 ${c.raw}%` } } },
        scales: { y: { ticks: { callback: v => `${v}%` }, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } },
      },
    }));
  }

  /* ---------- PDF 다운로드 ---------- */
  $('#downloadPdf').addEventListener('click', async () => {
    if (!current) return;
    if (!window.html2pdf) { window.print(); return; } // 라이브러리를 못 불러오면 인쇄 창에서 PDF로 저장
    const view = $('#view-result');
    const btn = $('#downloadPdf');
    btn.disabled = true;
    btn.textContent = 'PDF 만드는 중...';
    document.body.classList.add('pdf-mode');
    const safeName = current.product.name.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '상품';
    try {
      await html2pdf().set({
        margin: [10, 8, 12, 8],
        filename: `AI판매분석_${safeName}_${date(current.savedAt).replace(/[.\s]/g, '')}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', windowWidth: 960 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css'], avoid: ['.card', '.box', 'tr', '.score-row', '.kpis'] },
      }).from(view).save();
    } catch {
      alert('PDF를 만들지 못했습니다. 인쇄 창에서 "PDF로 저장"을 선택해 주세요.');
      window.print();
    } finally {
      document.body.classList.remove('pdf-mode');
      btn.disabled = false;
      btn.textContent = 'PDF 다운로드';
    }
  });

  // 이전 버전이 남긴 입력 임시 저장값을 지운다. 사이트를 열 때마다 빈 입력 화면으로 시작한다.
  try { localStorage.removeItem('sellhelper.draft'); } catch { /* 무시 */ }
  applyPlatformFee(false);
  liveCalc();
  updateSettingsButton();
})();
