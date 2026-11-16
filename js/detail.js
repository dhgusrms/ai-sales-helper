// 상세페이지 이미지: 판매 콘텐츠의 상세페이지 구성안과 상품 사진을 상품 종류에 맞는 양식에 배치한다.
// 상품 종류(식품·뷰티·패션 등)마다 섹션 순서, 제목, 배치 모양, 기본 색이 다르다.
// 가로 860px로 그리고, 내려받을 때는 2배(1720px) 해상도의 PNG로 저장한다.
const DetailPage = (() => {
  const WIDTH = 860;
  const THEMES = {
    navy: { label: '네이비', main: '#1e3a5f', soft: '#eef3f8' },
    green: { label: '그린', main: '#2f5d50', soft: '#edf5f1' },
    coral: { label: '코랄', main: '#b5503c', soft: '#fbf0ec' },
    orange: { label: '오렌지', main: '#c2571a', soft: '#fff3e8' },
    pink: { label: '핑크', main: '#b4436c', soft: '#fdf0f4' },
    blue: { label: '블루', main: '#1d4ed8', soft: '#eef4ff' },
    black: { label: '블랙', main: '#1f2937', soft: '#f3f4f6' },
  };
  const SLOT_LABELS = ['대표 사진', '강점 사진', '규격·구성 사진'];

  // 상품 종류별 양식.
  // order: 섹션 순서 / hero: 첫 화면 배치(top 사진 위·글 아래, split 사진·글 나란히, band 색 띠 위 글 + 사진)
  // worries·points: 목록 모양(quote 말풍선, numbered 번호, cards 카드 두 줄, checks 체크) / guide: bullets 점, steps 단계
  const TYPES = {
    basic: {
      label: '기본', theme: 'navy', hero: 'top', worries: 'quote', points: 'numbered', guide: 'bullets',
      order: ['worries', 'strengths', 'specs', 'guide'],
      titles: { worries: '이런 고민 있으셨나요?', strengths: '그래서 이렇게 만들었습니다', specs: '제품 정보', guide: '사용 안내 · 주의사항' },
    },
    living: {
      label: '생활·인테리어', theme: 'green', hero: 'top', worries: 'quote', points: 'numbered', guide: 'bullets',
      order: ['worries', 'strengths', 'specs', 'guide'],
      titles: { worries: '이런 고민 있으셨나요?', strengths: '생활이 편해지는 이유', specs: '제품 정보', guide: '사용 안내 · 주의사항' },
    },
    food: {
      label: '식품', theme: 'orange', hero: 'band', worries: 'checks', points: 'cards', guide: 'steps',
      order: ['strengths', 'worries', 'specs', 'guide'],
      titles: { worries: '이런 분께 추천해요', strengths: '맛있는 이유', specs: '제품 정보', guide: '보관 · 드시는 방법' },
    },
    beauty: {
      label: '뷰티·화장품', theme: 'pink', hero: 'split', worries: 'quote', points: 'checks', guide: 'steps',
      order: ['worries', 'strengths', 'guide', 'specs'],
      titles: { worries: '이런 고민 있으셨나요?', strengths: '핵심 포인트', specs: '제품 정보', guide: '사용 방법' },
    },
    fashion: {
      label: '패션·잡화', theme: 'black', hero: 'top', worries: 'checks', points: 'checks', guide: 'bullets',
      order: ['strengths', 'specs', 'worries', 'guide'],
      titles: { worries: '이럴 때 잘 어울려요', strengths: '스타일 포인트', specs: '사이즈 · 소재', guide: '세탁 · 관리 방법' },
    },
    digital: {
      label: '디지털·가전', theme: 'blue', hero: 'band', worries: 'quote', points: 'cards', guide: 'bullets',
      order: ['strengths', 'worries', 'specs', 'guide'],
      titles: { worries: '이런 불편함 있으셨나요?', strengths: '주요 기능', specs: '제품 사양', guide: '사용 안내 · 주의사항' },
    },
    handmade: {
      label: '핸드메이드·선물', theme: 'coral', hero: 'split', worries: 'checks', points: 'numbered', guide: 'bullets',
      order: ['worries', 'strengths', 'specs', 'guide'],
      titles: { worries: '이런 선물 찾고 계셨나요?', strengths: '정성을 담은 포인트', specs: '구성 · 크기', guide: '관리 방법' },
    },
  };
  const TYPE_KEYS = Object.keys(TYPES);
  const TITLE_KEYS = ['worries', 'strengths', 'specs', 'guide'];

  // 상품 종류 고르기: 카테고리 → AI가 고른 종류 → 상품명·설명 순서로 본다.
  const TYPE_WORDS = [
    ['food', /식품|음식|간식|과자|쿠키|빵|베이커리|떡|커피|원두|음료|주스|잼|김치|반찬|소스|양념|건강식품|농산|수산|축산|과일|채소|견과|티백|꿀|도시락|밀키트/],
    ['beauty', /뷰티|화장품|스킨|로션|크림|세럼|에센스|향수|비누|샴푸|바디|클렌징|네일|헤어|마스크팩|선크림/],
    ['digital', /디지털|가전|전자|컴퓨터|노트북|휴대폰|스마트폰|케이블|충전|이어폰|헤드폰|스피커|키보드|마우스|LED|USB|배터리|모니터/i],
    ['fashion', /패션|의류|셔츠|티셔츠|바지|원피스|스커트|니트|아우터|가방|지갑|신발|모자|액세서리|주얼리|목걸이|귀걸이|반지|팔찌|양말|스카프|잡화/],
    ['handmade', /핸드메이드|수공예|공예|선물|기프트|캔들|도자기|뜨개|자수|캘리|레진/],
    ['living', /생활|인테리어|수납|정리|주방|욕실|가구|침구|원목|트레이|청소|홈데코|러그|쿠션|조명|화분|문구/],
  ];
  function matchType(text) {
    const hit = TYPE_WORDS.find(([, re]) => re.test(text || ''));
    return hit ? hit[0] : '';
  }
  function guessType(product, content) {
    const cat = [product.catMain, product.catSub, product.category].filter(Boolean).join(' ');
    return matchType(cat)
      || (TYPES[content?.page_type] ? content.page_type : '')
      || matchType(`${product.name} ${product.description}`)
      || 'basic';
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // [일반 정보]·[입력 정보]는 분석용 표시라 상세페이지에서는 지운다. [확인 필요]는 사용자가 확인하도록 남긴다.
  const clean = t => String(t || '').replace(/\s*[[(](일반|입력) ?정보[\])]/g, '').trim();
  const sentences = t => clean(t).split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(Boolean);
  const VERIFY_RE = /\s*[[(]확인 ?필요[\])]/g;

  // 구성안의 블록을 이름으로 찾는다. 이름이 다르면 순서로 찾는다.
  function block(detail, keyword, index) {
    return detail.find(b => b.section.includes(keyword)) || detail[index] || { content: '', title: '' };
  }

  function buildModel(product, content, ai) {
    const d = content.detail_page || [];
    const hero = block(d, '대표', 0);
    const worry = block(d, '고민', 1);
    const strength = block(d, '강점', 2);
    const guide = block(d, '사용', 4);
    const points = (ai.selling_points || []).map(x => clean(x.point)).filter(Boolean);
    const type = guessType(product, content);
    // AI가 이 상품에 맞춰 지은 섹션 제목. 없으면(예전 콘텐츠) 양식의 기본 제목을 쓴다.
    const aiTitles = { worries: clean(worry.title), strengths: clean(strength.title), guide: clean(guide.title) };
    const m = {
      type,
      theme: TYPES[type].theme,
      aiTitles,
      title: clean(content.product_names?.[0]?.name) || product.name,
      hero: sentences(hero.content).slice(0, 2).join(' '),
      worries: sentences(worry.content).slice(0, 4),
      strengths: (points.length ? points : sentences(strength.content)).slice(0, 4),
      // 규격·인증은 AI 문장이 아니라 사용자가 입력한 값만 쓴다
      specs: [['재질', product.material], ['크기', product.size], ['구성품', product.components], ['인증', product.certification]]
        .filter(([, v]) => v).map(([k, v]) => ({ k, v })),
      guide: sentences(guide.content).slice(0, 5),
    };
    for (const k of TITLE_KEYS) m[`${k}Title`] = aiTitles[k] || TYPES[type].titles[k];
    m.specsTitle = TYPES[type].titles.specs;
    return m;
  }

  // 양식을 바꾼다. 사용자가 직접 고친 제목은 그대로 두고, 기본 제목만 새 양식의 제목으로 바꾼다.
  function applyType(m, type) {
    if (!TYPES[type]) return;
    const defaults = new Set(TYPE_KEYS.flatMap(t => Object.values(TYPES[t].titles)));
    for (const k of TITLE_KEYS) {
      const cur = m[`${k}Title`];
      const ai = m.aiTitles?.[k];
      if (!cur || defaults.has(cur)) m[`${k}Title`] = (k !== 'specs' && ai) || TYPES[type].titles[k];
    }
    m.type = type;
    m.theme = TYPES[type].theme;
  }

  function text(path, value, tag = 'span') {
    const html = esc(value).replace(VERIFY_RE, ' <mark class="verify">확인 필요</mark>');
    return `<${tag} class="dp-ed" contenteditable="true" spellcheck="false" data-dp="${path}">${html}</${tag}>`;
  }
  function photo(photos, i) {
    const p = photos[i];
    return p
      ? `<div class="dp-photo"><img src="${p.url}" alt="${SLOT_LABELS[i]}"></div>`
      : `<div class="dp-photo dp-photo-empty">${SLOT_LABELS[i]}을 올리면 이 자리에 들어갑니다</div>`;
  }

  // 목록 모양별 그리기
  function list(kind, items, path) {
    const ed = i => text(`${path}.${i}`, items[i]);
    if (kind === 'quote') return `<ul class="dp-worries">${items.map((_, i) => `<li>${ed(i)}</li>`).join('')}</ul>`;
    if (kind === 'checks') return `<ul class="dp-checks">${items.map((_, i) => `<li><span class="dp-check" aria-hidden="true">✓</span>${ed(i)}</li>`).join('')}</ul>`;
    if (kind === 'cards') return `<ol class="dp-cards">${items.map((_, i) => `<li><span class="dp-badge">${String(i + 1).padStart(2, '0')}</span>${ed(i)}</li>`).join('')}</ol>`;
    if (kind === 'steps') return `<ol class="dp-steps">${items.map((_, i) => `<li><span class="dp-step">STEP ${i + 1}</span>${ed(i)}</li>`).join('')}</ol>`;
    if (kind === 'bullets') return `<ul class="dp-guide">${items.map((_, i) => `<li>${ed(i)}</li>`).join('')}</ul>`;
    return `<ol class="dp-points">${items.map((_, i) => `<li><span class="dp-num">${String(i + 1).padStart(2, '0')}</span>${ed(i)}</li>`).join('')}</ol>`;
  }

  function render(m, photos) {
    if (m.v === 2) return renderAI(m, photos);
    const T = TYPES[m.type] || TYPES.basic;
    const t = THEMES[m.theme] || THEMES[T.theme];
    const specsTitle = m.specsTitle || '제품 정보';
    const heroText = `<div class="dp-hero-text">${text('title', m.title, 'h1')}${text('hero', m.hero, 'p')}</div>`;
    const hero = T.hero === 'split'
      ? `<section class="dp-hero dp-hero-split">${photo(photos, 0)}${heroText}</section>`
      : T.hero === 'band'
        ? `<section class="dp-hero dp-hero-band">${heroText}${photo(photos, 0)}</section>`
        : `<section class="dp-hero">${photo(photos, 0)}${heroText}</section>`;

    const sections = {
      worries: () => (m.worries.length ? `<section class="dp-sec">
        ${text('worriesTitle', m.worriesTitle, 'h2')}${list(T.worries, m.worries, 'worries')}</section>` : ''),
      strengths: () => (m.strengths.length ? `<section class="dp-sec">
        ${text('strengthsTitle', m.strengthsTitle, 'h2')}${list(T.points, m.strengths, 'strengths')}${photo(photos, 1)}</section>` : ''),
      specs: () => (m.specs.length ? `<section class="dp-sec">
        ${text('specsTitle', specsTitle, 'h2')}
        <table class="dp-specs">${m.specs.map((s, i) => `<tr><th>${esc(s.k)}</th><td>${text(`specs.${i}.v`, s.v)}</td></tr>`).join('')}</table>
        ${photo(photos, 2)}</section>` : ''),
      guide: () => (m.guide.length ? `<section class="dp-sec">
        ${text('guideTitle', m.guideTitle, 'h2')}${list(T.guide, m.guide, 'guide')}</section>` : ''),
    };
    // 색 배경을 번갈아 깔아 섹션이 구분되게 한다 (첫 화면이 색 배경인 split은 흰 배경부터)
    const offset = T.hero === 'split' ? 1 : 0;
    const body = T.order.map(k => sections[k]()).filter(Boolean)
      .map((html, i) => ((i + offset) % 2 === 0 ? html.replace('<section class="dp-sec">', '<section class="dp-sec dp-soft">') : html)).join('');
    return `<div class="dp dp-type-${m.type || 'basic'}" style="--dp-main:${t.main};--dp-soft:${t.soft};width:${WIDTH}px">${hero}${body}</div>`;
  }

  /* ---------- AI가 설계한 상세페이지 (v: 2) ---------- */
  // AI가 섹션 종류·순서·제목·분량을 정한다. 제품 정보 표만은 사용자가 입력한 값으로 채운다.
  function specsOf(product) {
    return [['재질', product.material], ['크기', product.size], ['구성품', product.components], ['인증', product.certification]]
      .filter(([, v]) => v).map(([k, v]) => ({ k, v }));
  }
  function fromAI(out, product) {
    return { v: 2, theme: out.theme || 'navy', hero: out.hero, sections: out.sections, specs: specsOf(product), model: out.model, madeAt: new Date().toISOString() };
  }
  // 섹션 종류 이름 (편집 화면의 구성 목록에 쓴다)
  const KIND_LABELS = { empathy: '고민 공감', points: '핵심 장점', detail: '디테일', scenes: '이런 분께', howto: '사용 방법', specs: '제품 정보', faq: '자주 묻는 질문', care: '관리·주의', closing: '마무리' };

  function renderAI(m, photos) {
    const t = THEMES[m.theme] || THEMES.navy;
    const h = m.hero || {};
    const badges = (h.badges || []).length
      ? `<div class="dp-badges">${h.badges.map((b, i) => text(`hero.badges.${i}`, b, 'span')).join('')}</div>` : '';
    const hero = `<section class="dp-hero">${photo(photos, 0)}<div class="dp-hero-text">
      ${h.eyebrow ? text('hero.eyebrow', h.eyebrow, 'p').replace('class="dp-ed"', 'class="dp-ed dp-eyebrow"') : ''}
      ${text('hero.headline', h.headline, 'h1')}${h.subcopy ? text('hero.subcopy', h.subcopy, 'p') : ''}${badges}</div></section>`;
    // 사진 2장(강점·규격)은 처음 나오는 핵심 장점(없으면 디테일) 섹션과 제품 정보 섹션 아래에 둔다
    const photo1At = m.sections.findIndex(x => x.kind === 'points') >= 0
      ? m.sections.findIndex(x => x.kind === 'points') : m.sections.findIndex(x => x.kind === 'detail');
    let soft = 0;
    const body = m.sections.map((sec, i) => {
      const p = `sections.${i}`;
      const it = (j, key, tag = 'span') => text(`${p}.items.${j}.${key}`, sec.items[j][key], tag);
      let inner = '';
      if (sec.kind === 'empathy') {
        inner = `<ul class="dp-worries">${sec.items.map((x, j) => `<li>${it(j, x.text ? 'text' : 'title')}</li>`).join('')}</ul>`;
      } else if (sec.kind === 'points') {
        inner = `<ol class="dp-feats">${sec.items.map((x, j) => `<li><span class="dp-feat-no">${String(j + 1).padStart(2, '0')}</span>
          <div>${x.title ? it(j, 'title', 'h3') : ''}${it(j, 'text', 'p')}</div></li>`).join('')}</ol>`;
      } else if (sec.kind === 'detail') {
        inner = `<div class="dp-tiles">${sec.items.map((x, j) => `<div class="dp-tile">${x.title ? it(j, 'title', 'h3') : ''}${it(j, 'text', 'p')}</div>`).join('')}</div>`;
      } else if (sec.kind === 'scenes') {
        inner = `<ul class="dp-checks">${sec.items.map((x, j) => `<li><span class="dp-check" aria-hidden="true">✓</span>
          <div>${x.title ? it(j, 'title', 'b') : ''}${x.text ? ` ${it(j, 'text')}` : ''}</div></li>`).join('')}</ul>`;
      } else if (sec.kind === 'howto') {
        inner = `<ol class="dp-steps">${sec.items.map((x, j) => `<li><span class="dp-step">STEP ${j + 1}</span>
          <div>${x.title ? it(j, 'title', 'b') : ''}${x.text ? ` ${it(j, 'text')}` : ''}</div></li>`).join('')}</ol>`;
      } else if (sec.kind === 'specs') {
        if (!m.specs.length) return '';
        inner = `<table class="dp-specs">${m.specs.map((s, j) => `<tr><th>${esc(s.k)}</th><td>${text(`specs.${j}.v`, s.v)}</td></tr>`).join('')}</table>`;
      } else if (sec.kind === 'faq') {
        inner = `<dl class="dp-faq">${sec.items.map((x, j) => `<div><dt><i class="dp-qa">Q</i>${it(j, 'title')}</dt><dd><i class="dp-qa">A</i>${it(j, 'text')}</dd></div>`).join('')}</dl>`;
      } else if (sec.kind === 'care') {
        inner = `<ul class="dp-guide">${sec.items.map((x, j) => `<li>${it(j, x.text ? 'text' : 'title')}</li>`).join('')}</ul>`;
      } else if (sec.kind === 'closing') {
        return `<section class="dp-sec dp-closing">${text(`${p}.title`, sec.title, 'h2')}${sec.lead ? text(`${p}.lead`, sec.lead, 'p') : ''}</section>`;
      }
      const pic = i === photo1At ? photo(photos, 1) : sec.kind === 'specs' ? photo(photos, 2) : '';
      const cls = soft++ % 2 === 1 ? 'dp-sec dp-soft' : 'dp-sec';
      return `<section class="${cls} dp-k-${sec.kind}">${text(`${p}.title`, sec.title, 'h2')}
        ${sec.lead ? text(`${p}.lead`, sec.lead, 'p').replace('class="dp-ed"', 'class="dp-ed dp-lead"') : ''}${inner}${pic}</section>`;
    }).join('');
    return `<div class="dp dp-ai" style="--dp-main:${t.main};--dp-soft:${t.soft};width:${WIDTH}px">${hero}${body}</div>`;
  }

  // 점검용: 모델 안의 모든 문장
  function allTexts(m) {
    if (m.v === 2) {
      const h = m.hero || {};
      return [h.eyebrow, h.headline, h.subcopy, ...(h.badges || []),
        ...m.sections.flatMap(x => [x.title, x.lead, ...x.items.flatMap(i => [i.title, i.text])]), ...m.specs.map(s => s.v)].filter(Boolean);
    }
    return [m.title, m.hero, m.worriesTitle, m.strengthsTitle, m.guideTitle, ...m.worries, ...m.strengths, ...m.specs.map(s => s.v), ...m.guide].filter(Boolean);
  }

  // 편집한 글자를 모델에 반영한다. '확인 필요' 표시는 [확인 필요] 글자로 되돌린다.
  function readText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('mark.verify').forEach(mk => mk.replaceWith(' [확인 필요]'));
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o == null ? o : o[k]), obj);
    if (target != null) target[last] = value;
  }

  // 내려받기 전 점검: 남은 '확인 필요' 표시, 과장 표현, 빈 사진 칸
  const RISKY_WORDS = ['최고', '최상', '1위', '최초', '유일', '완벽', '100%', '무해', '무독성', '부작용 없', '절대', '치료', '예방', '효능'];
  function check(m, photos, product) {
    const all = allTexts(m);
    const source = [product.name, product.description, product.material, product.size, product.components, product.certification].join(' ');
    const hasVerify = /[[(]확인 ?필요[\])]/; // 전역 플래그 없는 정규식이라 test를 반복해도 안전하다
    // AI 상세페이지는 제품 정보 섹션이 있을 때만 규격 사진 칸을 쓴다
    const usedSlots = m.v === 2 ? [true, m.sections.some(x => x.kind === 'points' || x.kind === 'detail'), m.specs.length > 0] : [true, true, true];
    return {
      verify: all.filter(t => hasVerify.test(t)).length,
      risky: RISKY_WORDS.filter(w => !source.includes(w) && all.some(t => t.includes(w))),
      emptyPhotos: SLOT_LABELS.filter((_, i) => usedSlots[i] && !photos[i]),
    };
  }

  async function exportPng(el, filename) {
    if (!window.html2canvas) throw new Error('이미지 변환 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    el.classList.add('dp-exporting');
    try {
      await document.fonts?.ready;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', width: WIDTH, windowWidth: WIDTH + 40 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return { width: canvas.width, height: canvas.height, bytes: blob.size };
    } finally {
      el.classList.remove('dp-exporting');
    }
  }

  return { THEMES, TYPES, TYPE_KEYS, SLOT_LABELS, KIND_LABELS, buildModel, fromAI, applyType, guessType, render, readText, setPath, check, exportPng };
})();
