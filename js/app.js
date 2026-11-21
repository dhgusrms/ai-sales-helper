// 화면 전환, 입력 처리, 결과 렌더링, 저장·비교·PDF.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const form = $('#productForm');
  const MAX_PHOTOS = 3;

  let photos = [];      // { mediaType, data(base64), url }
  // 경쟁상품·자료 입력은 뺐지만, AI 요청 형식과 예전 기록을 위해 빈 목록으로 넘긴다
  const competitors = [];
  const docs = [];
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
      components: (f.get('components') || '').trim() || '단품', // 비워 두면 단품
      ...readSize(f),
      ...readCert(f),
      costEntered: String(f.get('cost') || '').trim() !== '',
      feeEntered: String(f.get('feeRate') || '').trim() !== '',
      cost: parseNum(f.get('cost')),
      price: parseNum(f.get('price')),
      shipping: parseNum(f.get('shipping')),
      packaging: parseNum(f.get('packaging')),
      feeRate: parseNum(f.get('feeRate')),
      platform,
      targetMargin: f.get('targetMargin') === '' ? 30 : parseNum(f.get('targetMargin')),
      photos,
      docs,
      competitors,
    };
  }

  /* ---------- 크기·인증 (숫자 칸과 인증 종류로 입력받아 글로 합친다) ---------- */
  const SIZE_MAX = { cm: 1000, mm: 10000, m: 100 };
  const SIZE_UNITS = ['cm', 'mm', 'm'];
  // 직접 쓰기에서 고를 수 있는 단위 (''는 단위 없음: S·M·L처럼 단위가 필요 없는 크기)
  const FREE_UNITS = ['', 'mm', 'cm', 'm', 'ml', 'L', 'g', 'kg'];
  // 모양마다 쓰는 칸과 이름. 칸은 sizeW, sizeD, sizeH 순서로 앞에서부터 쓴다.
  const SIZE_SHAPES = {
    box: ['가로', '세로', '높이'],
    flat: ['가로', '세로'],
    round: ['지름', '높이'],
    length: ['길이'],
    free: [],
  };
  const SIZE_KEYS = ['sizeW', 'sizeD', 'sizeH'];
  const SIZE_HOLDERS = { box: ['30', '20', '4'], flat: ['60', '40'], round: ['8', '10'], length: ['150'] };
  const shapeOf = v => (SIZE_SHAPES[v] ? v : 'box');
  // 받침이 있으면 '은', 없으면 '는'
  const eunNeun = w => ((w.charCodeAt(w.length - 1) - 0xac00) % 28 ? `${w}은` : `${w}는`);

  function readSize(f) {
    const sizeShape = shapeOf(f.get('sizeShape'));
    const unit = SIZE_UNITS.includes(f.get('sizeUnit')) ? f.get('sizeUnit') : 'cm';
    const labels = SIZE_SHAPES[sizeShape];
    // 지금 모양에서 안 쓰는 칸은 비운 것으로 본다
    const dims = Object.fromEntries(SIZE_KEYS.map((k, i) => [k, i < labels.length ? String(f.get(k) || '').trim() : '']));
    const sizeText = sizeShape === 'free' ? String(f.get('sizeText') || '').trim() : '';
    const sizeTextUnit = sizeShape === 'free' && FREE_UNITS.includes(f.get('sizeTextUnit')) ? f.get('sizeTextUnit') : '';
    // 글에 이미 같은 단위를 붙여 썼으면(예: 230~280mm) 한 번 더 붙이지 않는다
    let size = sizeText && sizeTextUnit && !sizeText.toLowerCase().endsWith(sizeTextUnit.toLowerCase()) ? `${sizeText}${sizeTextUnit}` : sizeText;
    if (sizeShape !== 'free') {
      const parts = labels.map((l, i) => [l, dims[SIZE_KEYS[i]]]).filter(([, v]) => v !== '');
      size = parts.length ? `${parts.map(([k, v]) => `${k} ${v}`).join(' × ')}${unit}` : '';
    }
    return { ...dims, sizeShape, sizeUnit: unit, sizeText, sizeTextUnit, size };
  }
  function updateSizeUI() {
    const shape = shapeOf(form.elements.sizeShape.value);
    const labels = SIZE_SHAPES[shape];
    $('#sizeRow').hidden = shape === 'free';
    $('#sizeFree').hidden = shape !== 'free';
    $$('[data-slot]', form).forEach(box => {
      const i = Number(box.dataset.slot);
      box.hidden = i >= labels.length;
      if (i < labels.length) {
        box.querySelector('span').textContent = labels[i];
        box.querySelector('input').placeholder = SIZE_HOLDERS[shape]?.[i] || '';
      }
    });
    $$('[data-slot-x]', form).forEach(x => { x.hidden = Number(x.dataset.slotX) >= labels.length; });
  }
  form.elements.sizeShape.addEventListener('change', updateSizeUI);

  const CERT_TYPES = {
    kcSafety: { label: 'KC 안전인증', no: '인증번호', needNo: true, site: 'safety' },
    kcConfirm: { label: 'KC 안전확인', no: '안전확인신고번호', needNo: true, site: 'safety' },
    kcSupplier: { label: 'KC 공급자적합성확인', needNo: false },
    radio: { label: '전파인증(방송통신기자재 적합성평가)', no: '적합성평가 번호', needNo: true, site: 'radio' },
    other: { label: '', no: '번호', needNo: false, needName: true },
  };
  const CERT_SITES = {
    safety: '<a href="https://www.safetykorea.kr" target="_blank" rel="noopener">제품안전정보센터(safetykorea.kr)</a>',
    radio: '<a href="https://www.rra.go.kr" target="_blank" rel="noopener">국립전파연구원(rra.go.kr)</a>',
  };
  function readCert(f) {
    const certType = CERT_TYPES[f.get('certType')] ? f.get('certType') : '';
    const certNo = String(f.get('certNo') || '').replace(/\s+/g, '').toUpperCase();
    const certName = String(f.get('certName') || '').trim();
    const certVerified = !!f.get('certVerified');
    const t = CERT_TYPES[certType];
    const lookup = t?.site === 'safety' && kcState.no === certNo && kcState.status === 'ok' ? kcState.info : null;
    // AI와 상세페이지에는 사용자가 확인한 인증만 넘긴다
    let certification = '';
    if (t && certVerified) {
      if (certType === 'kcSupplier') certification = 'KC 공급자적합성확인 (인증번호가 없는 제도)';
      else if (certType === 'other') certification = `${certName}${certNo ? ` (번호 ${certNo})` : ''}`;
      else certification = `${t.label} (${t.no} ${certNo}${lookup ? `, 제품안전정보센터 조회: ${[lookup.product, lookup.model && `모델 ${lookup.model}`].filter(Boolean).join(' / ')}` : ''})`;
    }
    const certLookup = lookup ? { product: lookup.product, model: lookup.model, maker: lookup.maker, state: lookup.state, date: lookup.date, div: lookup.div } : null;
    return { certType, certNo, certName, certVerified, certification, certLookup };
  }
  function updateCertUI() {
    const type = form.elements.certType.value;
    const t = CERT_TYPES[type];
    $('#certNoField').hidden = !t || type === 'kcSupplier';
    $('#certNameField').hidden = type !== 'other';
    $('#certCheck').hidden = !t;
    $('#kcLookupBtn').hidden = t?.site !== 'safety';
    renderKC();
    if (!t) return;
    $('#certNoField .label').innerHTML = `${t.no || '번호'} ${t.needNo ? '<b>*</b>' : '<small class="muted">(있으면)</small>'}`;
    const help = {
      kcSafety: `<b>번호는 한 글자라도 다르면 조회되지 않아요.</b> 인증서·제품 라벨에 적힌 그대로 하이픈(-)과 끝의 영문 글자(A, B, C 등)까지 정확히 써 주세요. 번호를 쓰고 <b>조회</b>를 누르면 ${CERT_SITES.safety}에서 찾아 제품명·모델명·제조사를 보여 드려요. 내가 파는 상품(모델)이 맞는지 확인해 주세요.`,
      kcConfirm: `<b>번호는 한 글자라도 다르면 조회되지 않아요.</b> 인증서·제품 라벨에 적힌 그대로 하이픈(-)과 끝의 영문 글자(A, B, C 등)까지 정확히 써 주세요. 번호를 쓰고 <b>조회</b>를 누르면 ${CERT_SITES.safety}에서 찾아 제품명·모델명·제조사를 보여 드려요. 내가 파는 상품(모델)이 맞는지 확인해 주세요.`,
      kcSupplier: '공급자적합성확인은 인증번호가 없는 제도예요. 제조·수입업자가 시험해 안전기준에 맞는지 스스로 확인하고, 그 시험 결과(시험성적서)를 보관해야 해요.',
      radio: `적합성평가 번호(예: R-R-…, R-C-…)를 ${CERT_SITES.radio}에서 조회해 이 상품(모델)의 번호가 맞는지 확인해 주세요.`,
      other: '인증서나 시험성적서 원본을 보고 이름과 번호를 그대로 옮겨 적어 주세요.',
    }[type];
    $('#certHelp').innerHTML = help;
    $('#certVerifiedText').textContent = type === 'kcSupplier'
      ? '이 상품이 공급자적합성확인 대상이고, 시험 결과(시험성적서)를 확인했어요'
      : type === 'other' ? '인증서 원본을 보고 내용이 맞는 것을 확인했어요'
        : t.site === 'safety' ? '조회된 제품이 내가 파는 상품(같은 모델)이 맞아요'
          : '번호를 공식 사이트에서 조회해 이 상품의 인증이 맞는 것을 확인했어요';
  }

  // KC 안전인증·안전확인 번호는 Worker가 제품안전정보센터에서 실제로 조회한다.
  // status: ''(아직 안 함) | 'loading' | 'ok'(적합) | 'notfound' | 'badstate'(적합이 아님) | 'mismatch'(인증 종류가 다름) | 'error'(조회 실패)
  let kcState = { no: '', status: '', info: null };
  const kcUrl = no => `https://www.safetykorea.kr/search/searchPop?certNum=${encodeURIComponent(no)}`;
  function kcTypeMismatch(type, div) {
    if (!div) return false;
    if (type === 'kcSafety') return /안전확인/.test(div) && !/안전인증/.test(div);
    if (type === 'kcConfirm') return /안전인증/.test(div) && !/안전확인/.test(div);
    return false;
  }
  function renderKC() {
    const type = form.elements.certType.value;
    const box = $('#kcResult');
    const check = form.elements.certVerified;
    const isKC = CERT_TYPES[type]?.site === 'safety';
    const no = String(form.elements.certNo.value || '').replace(/\s+/g, '').toUpperCase();
    const s = isKC && kcState.no === no ? kcState : { status: '' };
    // KC는 조회에 성공했거나(적합), 조회 자체가 실패해 직접 확인해야 할 때만 체크할 수 있다
    check.disabled = isKC && !['ok', 'error'].includes(s.status);
    if (check.disabled) check.checked = false;
    $('#kcLookupBtn').disabled = s.status === 'loading';
    $('#kcLookupBtn').textContent = s.status === 'loading' ? '조회 중…' : s.status ? '다시 조회' : '조회';
    box.hidden = !isKC || !s.status || s.status === 'loading';
    if (box.hidden) return;
    const i = s.info || {};
    const link = `<a href="${kcUrl(s.no)}" target="_blank" rel="noopener">공식 조회 화면 열기</a>`;
    const rows = [['제품명', i.product], ['제품 분류', i.category], ['모델명', i.model], ['브랜드', i.brand], ['제조사', [i.maker, i.country].filter(Boolean).join(' · ')], ['인증구분', i.div], ['인증일자', i.date], ['인증상태', i.state]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    const kinds = { ok: 'is-ok', notfound: 'is-bad', badstate: 'is-bad', mismatch: 'is-bad', error: 'is-warn' };
    // 인증받은 제품과 판매 상품이 다른 종류라고 AI가 판단했으면 쓸 수 없다
    const m = s.status === 'ok' ? currentKcMatch() : null;
    if (m?.verdict === 'different') { check.disabled = true; check.checked = false; }
    box.className = `kc-result ${m?.verdict === 'different' ? 'is-bad' : kinds[s.status] || ''}`;
    const matchLine = !m ? '' : m.verdict === 'checking' ? '<p class="kc-match">AI가 이 인증이 판매하려는 상품의 것인지 확인하고 있어요…</p>'
      : m.verdict === 'same' ? `<p class="kc-match"><b>AI 확인:</b> 판매하려는 상품과 같은 종류의 제품 인증이에요. ${esc(m.reason)}</p>`
        : m.verdict === 'unsure' ? `<p class="kc-match"><b>AI 확인:</b> 같은 제품인지 판단하기 어려워요. 제품명·모델명을 직접 비교해 주세요. ${esc(m.reason)}</p>` : '';
    if (m?.verdict === 'different') {
      box.innerHTML = `<b>판매하려는 상품과 다른 제품의 인증번호예요.</b> ${esc(m.reason)} 이 상품에 맞는 인증번호를 쓰거나, 인증이 없다면 인증 종류를 '없음 / 모름'으로 바꿔 주세요.<dl>${rows}</dl>${link}`;
      return;
    }
    box.innerHTML = {
      ok: `<b>제품안전정보센터에서 확인된 번호예요.</b> 아래 제품이 내가 파는 상품(같은 모델)인지 확인해 주세요.<dl>${rows}</dl>${matchLine}${link}`,
      notfound: `<b>제품안전정보센터에 없는 번호예요.</b> 번호는 한 글자라도 다르면 조회되지 않아요. 인증서·제품 라벨과 한 글자씩 비교해 하이픈(-)과 끝의 영문 글자(A, B, C 등)까지 맞는지 확인해 주세요. 0과 O, 1과 I처럼 헷갈리는 글자도 확인해 주세요. 인증을 받지 않았다면 인증 종류를 '없음 / 모름'으로 바꿔 주세요.`,
      badstate: `<b>이 번호의 인증상태가 '${esc(i.state)}'예요.</b> 적합 상태가 아닌 인증은 판매 페이지에 쓸 수 없어요.<dl>${rows}</dl>${link}`,
      mismatch: `<b>이 번호는 '${esc(i.div)}'이에요.</b> 위의 인증 종류를 맞게 골라 주세요.<dl>${rows}</dl>${link}`,
      error: `<b>자동 조회를 하지 못했어요.</b> ${link}에서 직접 조회해, 내가 파는 상품(모델)의 인증이 맞는지 확인한 뒤 체크해 주세요.`,
    }[s.status] || '';
  }
  async function lookupKC() {
    const type = form.elements.certType.value;
    const no = String(form.elements.certNo.value || '').replace(/\s+/g, '').toUpperCase();
    if (CERT_TYPES[type]?.site !== 'safety' || !no) return;
    if (!certNoLooksValid(type, no)) {
      showFieldErrors([{ field: 'certNo', msg: '번호 형식이 아니에요. 인증서에 적힌 영문·숫자·하이픈(-)을 그대로 입력해 주세요.' }]);
      return;
    }
    if (kcState.no === no && kcState.status === 'loading') return;
    clearFieldError(form.elements.certNo);
    kcState = { no, status: 'loading', info: null };
    renderKC();
    let status, info = null;
    try {
      info = await AI.lookupKC(no);
      status = !info.found ? 'notfound' : kcTypeMismatch(type, info.div) ? 'mismatch' : info.state && info.state !== '적합' ? 'badstate' : 'ok';
    } catch {
      status = 'error';
    }
    // 조회하는 동안 번호나 종류를 바꿨으면 이 결과는 버린다
    const nowNo = String(form.elements.certNo.value || '').replace(/\s+/g, '').toUpperCase();
    if (nowNo !== no || form.elements.certType.value !== type) return;
    kcState = { no, status, info, match: null };
    renderKC();
    $('#certCheck').querySelectorAll('.field-err').forEach(el => el.remove());
    if (status === 'ok') ensureKcMatch();
  }

  // 인증받은 제품과 판매 상품이 같은 종류인지 AI가 판단한다. 상품명·카테고리·설명이 바뀌면 다시 판단한다.
  const kcMatchKey = () => {
    const p = readForm();
    return [kcState.no, p.name, p.category, p.description.slice(0, 400)].join('|');
  };
  function currentKcMatch() {
    const m = kcState.match;
    return m && m.key === kcMatchKey() ? m : null;
  }
  async function ensureKcMatch() {
    if (kcState.status !== 'ok' || !kcState.info || !AI.isReady()) return null;
    const p = readForm();
    if (!p.name) return null;
    const key = kcMatchKey();
    if (kcState.match?.key === key && kcState.match.verdict !== 'checking') return kcState.match;
    if (kcState.match?.key === key && kcState.match.pending) return kcState.match.pending;
    const state = kcState;
    const pending = AI.checkKcMatch(p, state.info)
      .then(r => r, () => null) // AI 판단에 실패하면 막지 않고 사용자 확인(체크)에 맡긴다
      .then(r => {
        if (kcState !== state || kcState.match?.key !== key) return null;
        kcState.match = r ? { key, ...r } : null;
        renderKC();
        return kcState.match;
      });
    state.match = { key, verdict: 'checking', pending };
    renderKC();
    return pending;
  }
  // 상품명을 다 쓰고 나오면, 이미 조회한 인증과 맞는지 다시 판단한다
  ['name', 'description'].forEach(n => form.elements[n].addEventListener('blur', () => { if (kcState.status === 'ok') ensureKcMatch(); }));
  $('#kcLookupBtn').addEventListener('click', lookupKC);
  // 번호를 다 쓰고 칸을 벗어나면 자동으로 한 번 조회한다
  form.elements.certNo.addEventListener('blur', () => {
    const no = String(form.elements.certNo.value || '').replace(/\s+/g, '').toUpperCase();
    if (no && kcState.no !== no && certNoLooksValid(form.elements.certType.value, no)) lookupKC();
  });
  form.elements.certType.addEventListener('change', () => {
    form.elements.certVerified.checked = false;
    // 종류만 바꿨으면 같은 번호의 조회 결과로 종류를 다시 맞춰 본다
    if (kcState.info?.found && ['ok', 'mismatch'].includes(kcState.status)) {
      const t = form.elements.certType.value;
      kcState.status = kcTypeMismatch(t, kcState.info.div) ? 'mismatch' : kcState.info.state && kcState.info.state !== '적합' ? 'badstate' : 'ok';
    }
    updateCertUI();
  });
  form.elements.certNo.addEventListener('input', () => { form.elements.certVerified.checked = false; renderKC(); });

  /* ---------- 입력 검사 ---------- */
  const LETTER_RE = /[가-힣A-Za-z]/;
  const letterCount = t => (t.match(/[가-힣A-Za-z]/g) || []).length;
  const MIN_PRICE = 100;        // 이보다 싸면 분석하지 않는다 (1원·2원 같은 장난 입력 방지)
  const CHECK_PRICE = 1000;     // 이보다 싸면 가격이 맞는지 한 번 확인한다
  const MIN_DESC = 20;

  // 막아야 하는 오류(errors)와, 확인만 받으면 되는 경고(warnings)를 돌려준다.
  function validate(p) {
    const errors = [];
    const err = (field, msg) => errors.push({ field, msg });

    if (!p.name) err('name', '상품명을 입력해 주세요.');
    else if (p.name.length < 2 || !LETTER_RE.test(p.name)) err('name', '상품명은 한글이나 영문을 넣어 2자 이상 써 주세요. 숫자·기호만으로는 안 돼요.');

    const catField = p.platform === 'custom' ? 'catCustom' : 'catMain';
    if (!p.catMain) err(catField, p.platform === 'custom' ? '카테고리를 입력해 주세요.' : '카테고리를 골라 주세요.');
    else if (p.platform === 'custom' && (p.catMain.length < 2 || !LETTER_RE.test(p.catMain))) err('catCustom', '카테고리는 한글이나 영문으로 써 주세요. 예) 생활용품 > 욕실용품');

    const d = p.description.replace(/\s+/g, '');
    if (!p.description) err('description', '제품 설명을 입력해 주세요.');
    else if (p.description.length < MIN_DESC || letterCount(d) < 10) err('description', `제품 설명을 ${MIN_DESC}자 이상, 무엇에 쓰는 상품인지 알 수 있게 써 주세요.`);
    else if (new Set(d).size < 5) err('description', '같은 글자 반복 말고 상품에 대한 설명을 써 주세요.');

    if (!p.costEntered) err('cost', '원가를 입력해 주세요. 원가가 없으면 0을 입력해 주세요.');
    if (p.price < MIN_PRICE) err('price', `판매가는 ${MIN_PRICE.toLocaleString('ko-KR')}원 이상이어야 해요.`);
    if (p.platform === 'custom' && !p.feeEntered) err('feeRate', '수수료를 입력해 주세요. 수수료가 없으면 0을 입력해 주세요.');
    else if (p.feeRate >= 100) err('feeRate', '수수료는 100% 미만이어야 해요.');
    if (p.targetMargin >= 100) err('targetMargin', '목표 마진율은 100% 미만이어야 해요.');

    SIZE_SHAPES[p.sizeShape].forEach((label, i) => {
      const k = SIZE_KEYS[i];
      if (p[k] === '') return;
      const n = Number(p[k]);
      if (!Number.isFinite(n) || n <= 0) err(k, `${eunNeun(label)} 0보다 큰 숫자로 입력해 주세요.`);
      else if (n > SIZE_MAX[p.sizeUnit]) err(k, `${label} ${p[k]}${p.sizeUnit}는 너무 커요. 단위(cm/mm/m)를 확인해 주세요.`);
    });
    if (p.sizeShape === 'free' && p.sizeText && !/[0-9A-Za-z가-힣]/.test(p.sizeText)) err('sizeText', '크기를 글자나 숫자로 써 주세요. 예) S·M·L');

    const t = CERT_TYPES[p.certType];
    if (t) {
      if (p.certType === 'other' && !p.certName) err('certName', '인증 이름을 입력해 주세요.');
      if (t.needNo && !p.certNo) err('certNo', `${t.no}를 입력해 주세요.`);
      else if (p.certNo && !certNoLooksValid(p.certType, p.certNo)) err('certNo', p.certType === 'radio'
        ? '적합성평가 번호 형식이 아니에요. R-R-…, R-C-…처럼 인증서에 적힌 그대로 입력해 주세요.'
        : '번호 형식이 아니에요. 인증서에 적힌 영문·숫자·하이픈(-)을 그대로 입력해 주세요.');
      const kc = t.site === 'safety' && p.certNo && certNoLooksValid(p.certType, p.certNo) ? (kcState.no === p.certNo ? kcState.status : '') : null;
      if (kc === '' || kc === 'loading') err('certNo', kc === 'loading' ? '번호를 조회하고 있어요. 잠시 후 다시 눌러 주세요.' : "번호 옆 '조회'를 눌러 제품안전정보센터에서 확인해 주세요.");
      else if (kc === 'notfound') err('certNo', '제품안전정보센터에 없는 번호예요. 하이픈(-)과 끝 글자까지 정확히 썼는지 확인하거나 인증 종류를 \'없음 / 모름\'으로 바꿔 주세요.');
      else if (kc === 'badstate') err('certNo', `인증상태가 '${kcState.info?.state}'인 번호예요. 적합 상태가 아닌 인증은 쓸 수 없어요.`);
      else if (kc === 'ok' && currentKcMatch()?.verdict === 'different') err('certNo', `판매하려는 상품과 다른 제품의 인증번호예요. ${currentKcMatch().reason} 맞는 번호를 쓰거나 인증 종류를 '없음 / 모름'으로 바꿔 주세요.`);
      else if (kc === 'mismatch') err('certType', `조회해 보니 이 번호는 '${kcState.info?.div}'이에요. 인증 종류를 맞게 골라 주세요.`);
      else if (!p.certVerified) err('certVerified', '확인했다면 체크해 주세요. 확인이 어려우면 인증 종류를 \'없음 / 모름\'으로 바꿔 주세요. 확인되지 않은 인증은 판매 페이지에 쓰면 안 돼요.');
    }

    const warnings = [];
    if (!errors.length) {
      const r = Profit.calc(p);
      if (p.cost === 0) warnings.push('원가가 0원이에요. 직접 만든 상품이나 이미 가진 재고처럼 원가가 없는 게 맞나요?');
      if (p.price < CHECK_PRICE) warnings.push(`판매가가 ${won(p.price)}이에요. 가격을 맞게 입력했나요?`);
      if (r.profit < 0) warnings.push(`이 가격이면 1개 팔 때마다 ${won(-r.profit)} 손해예요. 판매가와 비용을 확인해 주세요.`);
      if (p.shipping > p.price) warnings.push('배송비가 판매가보다 커요.');
      if (p.packaging > p.price) warnings.push('포장비가 판매가보다 커요.');
      if (p.platform === 'custom' && p.feeRate === 0) warnings.push('수수료가 0%예요. 판매처 수수료가 정말 없나요?');
    }
    return { errors, warnings };
  }

  // 인증마다 번호 규칙이 달라 자릿수까지는 검사하지 않는다. 공식 사이트 조회 확인을 함께 받는다.
  function certNoLooksValid(type, no) {
    if (!/^[A-Z0-9][A-Z0-9-]{3,39}$/.test(no) || !/\d/.test(no) && type !== 'radio') return false;
    if (type === 'radio') return /^(R-[A-Z]-|MSIP-|KCC-)[A-Z0-9-]+$/.test(no);
    return true;
  }

  function showFieldErrors(errors) {
    $$('.field-err', form).forEach(el => el.remove());
    $$('.invalid', form).forEach(el => el.classList.remove('invalid'));
    for (const { field, msg } of errors) {
      const el = form.elements[field];
      if (!el) continue;
      el.classList.add('invalid');
      const box = field === 'certVerified' ? $('#certCheck') : field.startsWith('size') ? $('#sizeField') : el.closest('.field');
      const p = document.createElement('p');
      p.className = 'field-err';
      p.textContent = msg;
      box.appendChild(p);
    }
  }
  // 고친 칸은 바로 오류 표시를 지운다. (목록에서 고르거나 'AI 추천 적용'처럼 change만 생기는 경우도 포함)
  function clearFieldError(el) {
    if (!el?.classList?.contains('invalid')) return;
    el.classList.remove('invalid');
    el.closest('.field')?.querySelectorAll(':scope > .field-err').forEach(x => x.remove());
  }
  form.addEventListener('input', e => clearFieldError(e.target));
  // 글자 칸에서 Enter를 누르면 폼이 바로 제출되어 아직 안 쓴 칸까지 경고가 뜬다. 대신 다음 칸으로 넘어간다.
  form.addEventListener('keydown', e => {
    const t = e.target;
    if (e.key !== 'Enter' || e.isComposing || t.tagName !== 'INPUT' || ['checkbox', 'radio', 'file', 'submit', 'button'].includes(t.type)) return;
    e.preventDefault();
    const items = [...form.elements].filter(x => !x.disabled && !x.hidden && x.type !== 'hidden' && x.offsetParent && /^(INPUT|SELECT|TEXTAREA)$/.test(x.tagName) && x.type !== 'file');
    items[items.indexOf(t) + 1]?.focus();
  });
  form.addEventListener('change', e => {
    if (e.target.tagName === 'SELECT' || (e.target.type !== 'checkbox' && e.target.value)) clearFieldError(e.target);
    if (e.target.name === 'certVerified' && e.target.checked) {
      e.target.classList.remove('invalid');
      $('#certCheck').querySelectorAll('.field-err').forEach(el => el.remove());
    }
  });

  let confirmedWarnings = '';
  function showWarnings(list) {
    const box = $('#formWarn');
    box.hidden = !list.length;
    if (!list.length) return;
    box.innerHTML = `<b>분석 전에 확인해 주세요</b><ul>${list.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      <div class="actions"><button type="button" class="btn-outline" id="warnFix">고칠게요</button>
      <button type="button" class="btn-primary" id="warnOk">맞아요, 분석할게요</button></div>`;
    $('#warnFix').addEventListener('click', () => { box.hidden = true; form.elements.price.focus(); });
    $('#warnOk').addEventListener('click', () => { confirmedWarnings = list.join('|'); box.hidden = true; form.requestSubmit(); });
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------- 입력 중 실시간 계산 ---------- */
  function liveCalc() {
    const p = readForm();
    renderSummary(p);
    const box = $('#liveCalc');
    if (p.price <= 0 || !p.costEntered) { box.innerHTML = ''; return; }
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
  form.elements.catMain.addEventListener('change', () => { fillSubs(); showCatNotice(''); applyPlatformFee(true); showCatSuggest(); });

  /* ---------- 상품명으로 대분류 추천 ---------- */
  // 상품명을 쓰고 다음 칸으로 넘어가면 AI가 그 판매처의 대분류 중 하나를 추천한다. 고른 값은 덮어쓰지 않는다.
  let catCtrl = null;
  let catKey = '';
  let catPick = '';
  function hideCatSuggest() {
    catCtrl?.abort();
    catCtrl = null;
    catKey = '';
    catPick = '';
    $('#catSuggest').hidden = true;
  }
  function showCatSuggest() {
    const box = $('#catSuggest');
    if (!catPick) return;
    const same = form.elements.catMain.value === catPick;
    box.classList.toggle('is-same', same);
    box.innerHTML = same
      ? `✓ AI 추천 대분류와 같아요: <b>${esc(catPick)}</b>`
      : `AI 추천 대분류: <b>${esc(catPick)}</b> <button type="button" class="link-btn" data-apply-cat>적용</button>`;
    box.hidden = false;
  }
  async function suggestCategory() {
    const id = form.elements.platform.value;
    const name = form.elements.name.value.trim();
    if (id === 'custom' || name.length < 2 || !LETTER_RE.test(name)) { hideCatSuggest(); return; }
    const key = `${id}|${name}`;
    if (key === catKey) return;
    hideCatSuggest();
    catKey = key;
    const ctrl = catCtrl = new AbortController();
    const box = $('#catSuggest');
    box.classList.remove('is-same');
    box.innerHTML = '<span class="muted">상품명에 맞는 대분류를 찾고 있어요...</span>';
    box.hidden = false;
    try {
      const cat = await AI.suggestCategory(name, Platforms.label(id), Platforms.mains(id), ctrl.signal);
      if (ctrl !== catCtrl) return;
      catCtrl = null;
      if (!cat) { box.hidden = true; return; }
      catPick = cat;
      showCatSuggest();
    } catch {
      if (ctrl !== catCtrl) return;
      catCtrl = null;
      catKey = '';
      box.hidden = true; // 추천은 보조 기능이라 실패해도 조용히 숨긴다
    }
  }
  form.elements.name.addEventListener('change', suggestCategory);
  form.elements.platform.addEventListener('change', suggestCategory);
  $('#catSuggest').addEventListener('click', e => {
    if (!e.target.closest('[data-apply-cat]') || !catPick) return;
    form.elements.catMain.value = catPick;
    form.elements.catMain.dispatchEvent(new Event('change', { bubbles: true }));
  });
  form.elements.catSub.addEventListener('change', () => applyPlatformFee(true));
  fillMains();

  form.addEventListener('input', liveCalc);

  function clearForm() {
    form.reset();
    photos = [];
    renderThumbs();
    showFieldErrors([]);
    $('#formError').textContent = '';
    $('#formWarn').hidden = true;
    typoCtrl?.abort();
    hideCatSuggest();
    typoItems = [];
    $('#typoBox').hidden = true;
    kcState = { no: '', status: '', info: null };
    updateCertUI();
    updateSizeUI();
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

  // 경쟁상품 입력·자료 업로드 기능은 2026-11-14에 뺐다. 예전 기록의 경쟁상품 분석은 결과 화면에서 그대로 보여 준다.

  /* ---------- AI 설정 ---------- */
  const dlg = $('#settings');
  function showProviderFields() {
    const v = $('input[name="provider"]:checked')?.value;
    $('#qwenSettings').hidden = v !== 'qwen';
    $('#cloudSettings').hidden = v !== 'cloud';
    $('#claudeSettings').hidden = v !== 'claude';
  }
  // 상단의 'AI 설정' 버튼은 2026-11-14에 뺐다 (기본은 무료 AI). 호출하는 곳이 남아 있어 함수는 둔다.
  function updateSettingsButton() {}
  $('#cloudOption').hidden = !AI.hasCloud();
  function openSettings() {
    $(`input[name="provider"][value="${AI.getProvider()}"]`).checked = true;
    $('#apiKey').value = AI.getKey();
    $('#rememberKey').checked = AI.isRemembered();
    $('#qwenModel').value = AI.getQwenModel();
    showProviderFields();
    dlg.showModal();
  }
  // 개발·테스트용: 주소 끝에 #settings 를 붙여 열면 AI 설정 창이 열린다 (Claude·Qwen으로 바꿀 때)
  if (location.hash === '#settings') openSettings();
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
  // 화면을 가리지 않고 오른쪽 아래 상자에 진행 상황을 보여 준다. 기다리는 동안 다른 화면을 봐도 된다.
  let jobOpenAction = null;
  function startLoading({ tips = [] } = {}) {
    loadingCtrl = new AbortController();
    $('#cancelLoading').disabled = false;
    $('#loadingSlow').hidden = true;
    $('#jobRun').hidden = false;
    $('#jobDone').hidden = true;
    $('#loading').classList.remove('is-done', 'is-fail');
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
  // 작업이 끝나면 상자를 '완료' 모양으로 바꾼다. 보던 화면은 그대로 두고, 버튼을 눌러야 결과로 간다.
  function finishLoading(text, { fail = false, openLabel = '결과 보기', onOpen = null } = {}) {
    clearInterval(loadingTimer);
    loadingTimer = null;
    loadingCtrl = null;
    $('#jobRun').hidden = true;
    $('#jobDone').hidden = false;
    $('#jobDoneText').textContent = text;
    $('#jobIcon').textContent = fail ? '!' : '✓';
    $('#loading').classList.toggle('is-done', !fail);
    $('#loading').classList.toggle('is-fail', fail);
    $('#jobOpen').textContent = openLabel;
    $('#jobOpen').hidden = !onOpen;
    jobOpenAction = onOpen;
    $('#loading').hidden = false;
  }
  $('#jobOpen').addEventListener('click', () => { const f = jobOpenAction; $('#loading').hidden = true; jobOpenAction = null; f?.(); });
  $('#jobClose').addEventListener('click', () => { $('#loading').hidden = true; jobOpenAction = null; });
  const isBusy = () => !!loadingCtrl;
  const ANALYZE_TIPS = ['상품의 주요 특징과 장단점', '타깃 고객층과 시장성', '차별화 요소와 판매 위험요소', '종합 점수와 판정 근거'];
  const CONTENT_TIPS = ['상품명 후보', '검색 키워드', '상세페이지 구성안', '홍보문구'];
  const DETAIL_TIPS = ['상품에 맞는 섹션 고르기', '섹션 순서와 제목 정하기', '핵심 장점 자세히 쓰기', '자주 묻는 질문과 관리 방법'];
  $('#cancelLoading').addEventListener('click', () => {
    if (!loadingCtrl) return;
    $('#cancelLoading').disabled = true;
    loadingCtrl.abort(); // 진행 중인 AI 요청을 끊으면 기다리던 작업이 바로 끝난다
  });

  /* ---------- 오타 검사 ---------- */
  // AI가 찾은 오타를 보여 주고, 사용자가 '고치기'를 눌러야 칸의 글을 바꾼다.
  const TYPO_FIELDS = ['name', 'description', 'material', 'components', 'certName'];
  let typoItems = [];
  let typoCtrl = null;
  function renderTypos(msg) {
    const box = $('#typoBox');
    box.hidden = false;
    if (msg) { box.innerHTML = `<p class="small">${msg}</p>`; return; }
    if (!typoItems.length) {
      box.innerHTML = '<p><b>오타를 찾지 못했어요.</b> <span class="muted small">AI 검사라 놓친 오타가 있을 수 있어요.</span></p>';
      return;
    }
    box.innerHTML = `<h3>고칠 만한 곳 ${typoItems.length}개</h3>
      <ul class="typo-list">${typoItems.map((t, i) => `<li>
        <div><div class="typo-fix"><span class="pill">${esc(t.label)}</span><del>${esc(t.wrong)}</del> → <ins>${esc(t.right)}</ins></div>
          ${t.reason ? `<div class="muted small">${esc(t.reason)}</div>` : ''}</div>
        <button type="button" class="btn-outline" data-typo-fix="${i}">고치기</button></li>`).join('')}</ul>
      <div class="typo-foot"><button type="button" class="btn-text" data-typo-close>닫기</button>
        ${typoItems.length > 1 ? '<button type="button" class="btn-outline" data-typo-all>모두 고치기</button>' : ''}</div>
      <p class="muted small">AI 검사 결과예요. 고치기 전에 맞는지 확인해 주세요.</p>`;
  }
  function applyTypo(t) {
    const el = form.elements[t.field];
    if (el && el.value.includes(t.wrong)) el.value = el.value.replace(t.wrong, t.right);
  }
  $('#typoBtn').addEventListener('click', async () => {
    if (!AI.isReady()) { openSettings(); return; }
    const fields = Object.fromEntries(TYPO_FIELDS.map(k => [k, form.elements[k]?.value || '']));
    if (!Object.values(fields).some(v => v.trim())) { renderTypos('검사할 글이 없어요. 상품명이나 설명을 먼저 써 주세요.'); return; }
    const btn = $('#typoBtn');
    btn.disabled = true;
    btn.textContent = '검사 중…';
    renderTypos('AI가 오타를 찾고 있어요. 보통 10~30초 걸려요.');
    typoCtrl = new AbortController();
    try {
      typoItems = await AI.proofread(fields, typoCtrl.signal);
      renderTypos();
    } catch (ex) {
      if (!typoCtrl?.signal.aborted) renderTypos(`오타 검사를 하지 못했어요. ${esc(ex.message)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '오타 검사';
      typoCtrl = null;
    }
  });
  $('#typoBox').addEventListener('click', e => {
    const one = e.target.closest('[data-typo-fix]');
    if (one) {
      applyTypo(typoItems[Number(one.dataset.typoFix)]);
      typoItems.splice(Number(one.dataset.typoFix), 1);
    } else if (e.target.closest('[data-typo-all]')) {
      typoItems.forEach(applyTypo);
      typoItems = [];
    } else if (e.target.closest('[data-typo-close]')) {
      $('#typoBox').hidden = true;
      return;
    } else return;
    liveCalc();
    if (typoItems.length) renderTypos(); else renderTypos('모두 고쳤어요.');
  });

  /* ---------- 분석 실행 ---------- */
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (isBusy()) return; // AI 작업이 끝날 때까지 다시 분석하지 않는다
    // KC 인증을 조회했다면, 이 상품의 인증이 맞는지 AI 판단이 끝난 뒤에 검사한다
    if (kcState.status === 'ok' && !currentKcMatch()?.reason && form.elements.name.value.trim()) {
      $('#formError').textContent = 'KC 인증이 이 상품의 것인지 확인하고 있어요…';
      await ensureKcMatch();
      $('#formError').textContent = '';
    }
    const product = readForm();
    const { errors, warnings } = validate(product);
    showFieldErrors(errors);
    $('#formError').textContent = errors.length ? `고쳐야 할 칸이 ${errors.length}개 있어요. 빨간 안내를 확인해 주세요.` : '';
    if (errors.length) {
      $('#formWarn').hidden = true;
      // 버튼이 아래에 있으므로, 빠진 칸이 보이도록 그 칸으로 이동한다
      const bad = $('.invalid', form);
      if (bad) { bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); bad.focus({ preventScroll: true }); }
      return;
    }
    if (warnings.length && warnings.join('|') !== confirmedWarnings) { showWarnings(warnings); return; }
    $('#formWarn').hidden = true;

    const profit = Profit.calc(product);
    let ai = null, aiError = null;
    if (AI.isReady()) {
      $('#loadingText').textContent = 'AI가 상품을 분석하고 있습니다';
      const tips = ANALYZE_TIPS;
      const signal = startLoading({ tips });
      $$('[data-analyze]').forEach(b => { b.disabled = true; });
      try { ai = await AI.analyze(product, profit, signal); } catch (ex) { aiError = { code: ex.code, message: ex.message }; }
      $$('[data-analyze]').forEach(b => { b.disabled = false; });
      // 취소하면 저장하지 않는다 (입력한 내용은 남아 있음)
      if (signal.aborted) {
        stopLoading();
        $('#formError').textContent = '분석을 취소했습니다. 내용을 고친 뒤 다시 분석할 수 있습니다.';
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
        sizeShape: product.sizeShape, sizeText: product.sizeText, sizeTextUnit: product.sizeTextUnit,
        sizeW: product.sizeW, sizeD: product.sizeD, sizeH: product.sizeH, sizeUnit: product.sizeUnit,
        components: product.components, certification: product.certification,
        certType: product.certType, certNo: product.certNo, certName: product.certName, certVerified: product.certVerified, certLookup: product.certLookup,
        cost: product.cost, price: product.price, shipping: product.shipping, packaging: product.packaging,
        feeRate: product.feeRate, platform: product.platform, targetMargin: product.targetMargin,
        competitors: product.competitors,
        docNames: product.docs.map(d => d.name),
        thumb: photos[0] ? (await shrink(photos[0].url, 160)).url : null,
        photoCount: photos.length,
      },
      profit, ai, aiError, scores, verdict,
    };
    record.saved = Store.save(record);
    formRecordId = record.id;
    if (!ai && aiError?.code === 'no-key') { showRecord(record); return; }
    // 보던 화면은 그대로 두고, 오른쪽 아래 상자에서 결과로 이동한다
    finishLoading(ai ? `'${product.name}' 분석이 끝났어요` : 'AI 분석은 실패했지만 수익성 계산은 저장했어요',
      { fail: !ai, onOpen: () => showRecord(record) });
  });

  function showRecord(record) {
    current = record;
    renderResult();
    $('.step[data-go="result"]').disabled = false;
    go('result');
  }

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
    if (!product.thumb && product.photoCount === 0) {
      html += '<p class="note small">사진 없이 분석했습니다. 상세페이지 이미지는 사진을 추가한 뒤 만들 수 있어요.</p>';
    }
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
      <div class="box-head"><h2>AI 종합 평가</h2></div>
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
    if (!hasInput) return ''; // 경쟁상품 입력 기능을 뺐으므로, 예전 기록에만 보인다
    const st = Profit.competitorStats(product);
    const c = ai?.competition;
    let html = `<div class="card"><h2>경쟁상품 분석 <small class="muted">(직접 입력한 정보 기준)</small></h2>`;

    if (st) {
      html += `<div class="kpis">
        <div class="kpi"><div class="k">경쟁상품 평균가 (${st.count}개)</div><div class="v">${won(st.avg)}</div></div>
        <div class="kpi"><div class="k">경쟁 가격 범위</div><div class="v" style="font-size:22px">${won(st.min)} ~ ${won(st.max)}</div></div>
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

  // 사진으로 본 제품: 사진을 AI에 함께 보낸 분석에만 있다.
  function photoReviewBox(pr) {
    if (!pr) return '';
    const part = (title, key) => pr[key]?.length ? `<p class="photo-review-h">${title}</p>${list(pr[key], `photo_review.${key}`)}` : '';
    return box('사진으로 본 제품', `
      <p class="muted small">AI가 올린 사진만 보고 한 참고 의견이에요. 무게·내구성·실제 품질은 직접 확인해 주세요.</p>
      ${part('좋아 보이는 점', 'good')}${part('아쉬워 보이는 점', 'bad')}${part('사진을 더 좋게 하려면', 'tips')}`);
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
      ${photoReviewBox(ai.photo_review)}
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
      ${contentBox('상품명 후보', `<ul class="list-plain">${c.product_names.map((x, i) => `<li><b>${ed(`content.product_names.${i}.name`, x.name)}</b>
          <div class="sub">${ed(`content.product_names.${i}.reason`, x.reason)}</div></li>`).join('')}</ul>`)}
      ${contentBox('검색 키워드', `<p class="keywords">${c.keywords.map((k, i) => ed(`content.keywords.${i}`, k)).join('<span class="sep">, </span>')}</p>
          <p class="muted small">AI가 제안한 후보입니다. 실제 검색량은 확인되지 않았으니 네이버 데이터랩 등에서 직접 확인해 주세요.</p>`)}
      ${contentBox('상세페이지 구성안 (위에서 아래 순서)', `<ol class="detail-list">${c.detail_page.map((x, i) => `<li><b>${esc(x.section)}</b>${x.title ? ` <span class="muted">· 제목: ${esc(x.title)}</span>` : ''}
          <div>${ed(`content.detail_page.${i}.content`, x.content)}</div>
          <div class="sub">근거: ${ed(`content.detail_page.${i}.evidence`, x.evidence)}</div></li>`).join('')}</ol>`)}
      ${contentBox('홍보문구', `<ul class="list-plain">${c.promo_copies.map((x, i) => `<li><span class="pill">${esc(x.channel)}</span>
          <div class="promo">${ed(`content.promo_copies.${i}.text`, x.text)}</div></li>`).join('')}</ul>`)}
      </div>
      <p class="disclaimer">AI가 만든 <b>초안</b>입니다. 상품의 사실과 다르거나 과장된 표현이 없는지 확인한 뒤 사용해 주세요. 각 항목의 <b>수정</b> 버튼으로 고칠 수 있습니다. (모델: ${esc(c.model)})</p>
    </div>`;
  }

  async function makeContent() {
    if (!current?.ai) return;
    if (!AI.isReady()) { openSettings(); return; }
    if (isBusy()) { alert('AI가 다른 작업을 하고 있어요. 오른쪽 아래 상자에서 끝나면 다시 눌러 주세요.'); return; }
    const rec = current; // 기다리는 동안 다른 기록을 열어도 이 기록에 저장한다
    // 저장된 분석에는 사진·자료 원본이 없으므로 글 정보만으로 만든다
    const product = { ...rec.product, photos: [], docs: [] };
    $('#loadingText').textContent = 'AI가 판매 콘텐츠를 만들고 있습니다';
    const signal = startLoading({ tips: CONTENT_TIPS });
    const openContent = () => { showRecord(rec); $('#contentCard')?.scrollIntoView({ block: 'start' }); };
    try {
      rec.ai.content = await AI.generateContent(product, rec.profit, rec.ai, signal);
      delete rec.ai.detailPage; // 새 콘텐츠로 상세페이지를 다시 만든다
      rec.saved = Store.save(rec);
      if (current === rec && !$('#view-result').hidden) renderResult();
      finishLoading('판매 콘텐츠를 만들었어요', { openLabel: '콘텐츠 보기', onOpen: openContent });
    } catch (ex) {
      if (signal.aborted) stopLoading();
      else finishLoading(`판매 콘텐츠를 만들지 못했어요. ${ex.message}`, { fail: true });
    }
  }

  /* ---------- 상세페이지 만들기 ---------- */
  // 문구와 색상은 분석 기록에 저장하고, 사진은 용량 때문에 이번 화면에서만 쓴다.
  let detailPhotos = [null, null, null];
  let detailPhotosFor = null; // 어느 기록의 사진인지

  function preparePhotos(rec) {
    if (detailPhotosFor !== rec.id) {
      // 방금 분석한 상품이면 입력 화면에 올린 사진을 그대로 쓴다
      detailPhotos = rec.id === formRecordId ? [0, 1, 2].map(i => photos[i] || null) : [null, null, null];
      detailPhotosFor = rec.id;
    }
  }
  function showDetail() {
    renderDetailPanel();
    renderShots();
    renderDetailPreview();
    go('detail');
  }

  function openDetail() {
    if (!current?.ai?.content) return;
    preparePhotos(current);
    // 아직 없거나 예전 양식으로 만든 상세페이지면 AI가 이 상품에 맞춰 새로 설계한다
    if (!DetailPage.isCurrent(current.ai.detailPage)) { makeDetailPage(current); return; }
    showDetail();
  }

  // AI가 상품 정보·분석·판매 콘텐츠 초안(·사진)을 보고 상세페이지 전체를 설계한다.
  async function makeDetailPage(rec, request = '') {
    if (!AI.isReady()) { openSettings(); return; }
    if (isBusy()) { alert('AI가 다른 작업을 하고 있어요. 오른쪽 아래 상자에서 끝나면 다시 눌러 주세요.'); return; }
    preparePhotos(rec);
    const urls = rec.id === detailPhotosFor ? detailPhotos.map(p => p?.url) : [];
    const product = { ...rec.product, photos: [], docs: [] };
    $('#loadingText').textContent = 'AI가 이 상품에 맞는 상세페이지를 만들고 있습니다';
    const signal = startLoading({ tips: DETAIL_TIPS });
    const open = () => { current = rec; preparePhotos(rec); showDetail(); };
    // 버튼을 누른 화면(결과·상세페이지)에 그대로 있으면 끝나자마자 연다
    const stayed = () => current === rec && (!$('#view-result').hidden || !$('#view-detail').hidden);
    try {
      const out = await AI.generateDetailPage(product, rec.profit, rec.ai, urls, signal, { request, previous: rec.ai.detailPage });
      rec.ai.detailPage = DetailPage.fromAI(out, rec.product);
      rec.saved = Store.save(rec);
      if (stayed()) { stopLoading(); open(); return; }
      finishLoading(`'${rec.product.name}' 상세페이지를 만들었어요`, { openLabel: '상세페이지 보기', onOpen: open });
    } catch (ex) {
      if (signal.aborted) { stopLoading(); return; }
      // 다시 만들기에 실패하면 이전 상세페이지는 그대로 둔다
      const hasOld = DetailPage.isCurrent(rec.ai.detailPage);
      finishLoading(`상세페이지를 만들지 못했어요. ${hasOld ? '이전 상세페이지는 그대로 있어요. ' : "'상세페이지 만들기'를 다시 눌러 주세요. "}${ex.message}`,
        { fail: true, openLabel: '상세페이지 보기', onOpen: hasOld ? open : null });
    }
  }

  function renderDetailPanel() {
    const m = current.ai.detailPage;
    $('#dpAiInfo').innerHTML = `AI가 이 상품에 맞춰 <b>${m.sections.length}개 섹션</b>으로 짰어요: ${m.sections.map(x => esc(DetailPage.KIND_LABELS[x.kind] || x.kind)).join(' → ')}`
      + (m.request ? `<br>반영한 요청: “${esc(m.request)}”` : '');
    $('#dpRequest').value = m.request || '';
    $('#dpThemes').innerHTML = Object.entries(DetailPage.THEMES).map(([id, t]) =>
      `<button type="button" class="dp-theme ${m.theme === id ? 'is-active' : ''}" data-theme="${id}"><i style="background:${t.main}"></i>${t.label}</button>`).join('');
    const rec = DetailPage.SLOT_LABELS.map(label => m.shots?.shots.find(x => x.slot === label));
    $('#dpSlots').innerHTML = DetailPage.SLOT_LABELS.map((label, i) => {
      const p = detailPhotos[i];
      return `<div class="dp-slot"><span class="thumb-s" style="${p ? `background-image:url(${p.url})` : ''}"></span>
        <span class="name">${label}${rec[i] ? `<small class="dp-slot-rec">추천: ${esc(rec[i].title)}</small>` : ''}</span>
        <input type="file" accept="image/*" hidden data-slot-input="${i}">
        <button type="button" class="link-btn" data-slot-pick="${i}">${p ? '변경' : '올리기'}</button>
        ${p ? `<button type="button" class="link-btn danger" data-slot-clear="${i}">빼기</button>` : ''}</div>`;
    }).join('');
    $('#dpPhotoNote').textContent = '사진은 저장되지 않습니다. 저장된 분석을 다시 열면 사진을 다시 올려 주세요. 사진이 없는 칸은 이미지에서 빠집니다.';
  }
  // AI 추천 사진: 결과는 상세페이지와 함께 저장한다 (상세페이지를 다시 만들면 새로 받는다)
  function renderShots() {
    const r = current.ai.detailPage.shots;
    if (shotBusyFor === current) return;
    $('#dpShotIntro').hidden = !!r;
    $('#dpShots').innerHTML = r ? `<ul class="dp-shots">${r.shots.slice(0, 4).map(x => `<li>
        <span class="dp-shot-slot ${x.slot === '추가 사진' ? 'is-extra' : ''}">${esc(x.slot)}</span>
        <b>${esc(x.title)}</b>${x.why ? `<p class="why">${esc(x.why)}</p>` : ''}
        ${x.prompt ? `<div class="dp-prompt"><p>${esc(x.prompt)}</p><button type="button" class="link-btn" data-copy-prompt="${esc(x.prompt)}">프롬프트 복사</button></div>
        ${x.prompt_en ? `<details class="dp-prompt-en"><summary>영어 프롬프트</summary><p>${esc(x.prompt_en)}</p><button type="button" class="link-btn" data-copy-prompt="${esc(x.prompt_en)}">영어 복사</button></details>` : ''}`
        : `<p>${esc(x.how || '')}</p>`}</li>`).join('')}</ul>
        <p class="dp-shot-note">이미지 생성 AI에 <b>실제 상품 사진을 함께 첨부</b>하고 프롬프트를 붙여 넣으세요. 만든 이미지가 실제 상품과 모양·색·구성이 다르면 쓰지 마세요. 실제와 다른 이미지는 허위 표시가 될 수 있어요.</p>
        ${r.current ? `<p class="dp-shot-now"><b>올린 사진 보기</b> ${esc(r.current)}</p>` : ''}` : '';
    $('#dpShotBtn').disabled = false;
    $('#dpShotBtn').textContent = r ? '다시 추천 받기' : 'AI에게 프롬프트 추천 받기';
    $('#dpShotMsg').hidden = true;
  }
  let shotBusyFor = null;
  $('#dpShots').addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy-prompt]');
    if (btn) flash(btn, (await copyText(btn.dataset.copyPrompt)) ? '복사됨' : '복사 실패');
  });
  $('#dpShotBtn').addEventListener('click', async () => {
    if (!AI.isReady()) { openSettings(); return; }
    const rec = current;
    const page = rec.ai.detailPage;
    shotBusyFor = rec;
    $('#dpShotBtn').disabled = true;
    $('#dpShotBtn').textContent = 'AI가 프롬프트를 쓰는 중… (20~40초)';
    $('#dpShotMsg').hidden = true;
    try {
      const urls = rec.id === detailPhotosFor ? detailPhotos.map(p => p?.url) : [];
      const out = await AI.suggestPhotos({ ...rec.product, photos: [], docs: [] }, rec.ai, page, urls);
      page.shots = { shots: out.shots, current: out.current, model: out.model, madeAt: new Date().toISOString() };
      rec.saved = Store.save(rec);
      shotBusyFor = null;
      if (current === rec && current.ai.detailPage === page) { renderShots(); renderDetailPanel(); }
    } catch (ex) {
      shotBusyFor = null;
      if (current !== rec) return;
      renderShots();
      $('#dpShotMsg').hidden = false;
      $('#dpShotMsg').className = 'small is-error';
      $('#dpShotMsg').textContent = `추천을 받지 못했어요. 다시 눌러 주세요. ${ex.message || ''}`;
    }
  });

  function renderDetailPreview() {
    $('#dpPreview').innerHTML = DetailPage.render(current.ai.detailPage, detailPhotos);
  }

  $('#dpRegen').addEventListener('click', () => {
    const request = $('#dpRequest').value.trim();
    const msg = request
      ? `요청을 반영해 상세페이지를 다시 만들어요.\n\n“${request}”\n\n지금 고친 글자는 사라집니다. 다시 만들까요?`
      : 'AI가 상세페이지를 처음부터 다시 만들어요. 지금 고친 글자는 사라집니다. 다시 만들까요?';
    if (!confirm(msg)) return;
    document.activeElement?.blur();
    makeDetailPage(current, request);
  });
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
  // 수정·복사 버튼은 판매 콘텐츠 초안에만 둔다 (분석 결과는 읽기 전용)
  function box(title, body, tools = false) {
    return `<div class="box" data-box><div class="box-head"><h3>${title}</h3>${tools ? TOOLS : ''}</div><div class="box-body">${body}</div></div>`;
  }
  function contentBox(title, body) {
    return box(title, body, true);
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
  const ACCENT = '#23824f';
  const SERIES = ['#23824f', '#f59e0b', '#7c3aed', '#0369a1', '#db2777'];
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
            backgroundColor: 'rgba(35,130,79,.14)', borderColor: ACCENT, pointBackgroundColor: ACCENT, borderWidth: 2,
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
    const costColors = { '상품 원가': '#1f5f3a', '배송비': '#3a9a62', '포장비': '#93cfa8', '수수료': '#d4ecdc', '순이익': '#f59e0b' };
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
    // PDF 폭에 맞춰 차트 크기를 바로 다시 잡는다. (크기가 0인 차트가 있으면 PDF 도구가 멈춘다)
    const fitCharts = () => charts.forEach(c => { try { c.resize(); } catch { /* 무시 */ } });
    fitCharts();
    // 브라우저가 차트 크기 변경을 한 박자 늦게 반영하는 경우가 있어, 한 번 쉬고 다시 맞춘다
    await new Promise(r => setTimeout(r, 80)); // 화면이 가려진 탭에서도 멈추지 않게 requestAnimationFrame은 쓰지 않는다
    fitCharts();
    // 섹션(카드)마다 새 페이지에서 시작한다. 첫 카드는 제목 바로 아래에 둔다. 화면에 안 보이는 카드는 건너뛴다.
    const breakCards = $$('.card', view).filter(c => c.offsetParent).slice(1);
    breakCards.forEach(c => c.classList.add('pdf-break'));
    const safeName = current.product.name.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '상품';
    try {
      await html2pdf().set({
        margin: [10, 8, 12, 8],
        filename: `AI판매분석_${safeName}_${date(current.savedAt).replace(/[.\s]/g, '')}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', windowWidth: 960 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css'], before: '.pdf-break', avoid: ['.box', '.two-col', 'tr', '.score-row', '.kpis', '.chart-box'] },
      }).from(view).save();
    } catch {
      alert('PDF를 만들지 못했습니다. 인쇄 창에서 "PDF로 저장"을 선택해 주세요.');
      window.print();
    } finally {
      document.body.classList.remove('pdf-mode');
      breakCards.forEach(c => c.classList.remove('pdf-break'));
      fitCharts();
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
