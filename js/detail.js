// 상세페이지 이미지: AI가 상품 정보·분석 결과·판매 콘텐츠 초안(·사진)을 보고 설계한 상세페이지를 그린다.
// 섹션 종류·순서·제목·분량·색은 AI가 정하고(js/ai.js의 generateDetailPage), 색은 편집 화면에서 바꿀 수 있다.
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

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // [확인 필요]는 사용자가 확인하도록 표시로 남긴다. ([일반 정보] 같은 분석용 표시는 js/ai.js에서 이미 지운다)
  const VERIFY_RE = /\s*[[(]확인 ?필요[\])]/g;

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

  /* ---------- AI가 설계한 상세페이지 ---------- */
  // AI가 섹션 종류·순서·제목·분량을 정한다. 제품 정보 표만은 사용자가 입력한 값으로 채운다.
  function specsOf(product) {
    return [['재질', product.material], ['크기', product.size], ['구성품', product.components], ['인증', product.certification]]
      .filter(([, v]) => v).map(([k, v]) => ({ k, v }));
  }
  function fromAI(out, product) {
    return { v: 2, theme: out.theme || 'navy', hero: out.hero, sections: out.sections, specs: specsOf(product), model: out.model, request: out.request || '', madeAt: new Date().toISOString() };
  }
  // 섹션 종류 이름 (편집 화면의 구성 목록에 쓴다)
  const KIND_LABELS = { empathy: '고민 공감', points: '핵심 장점', detail: '디테일', scenes: '이런 분께', howto: '사용 방법', specs: '제품 정보', faq: '자주 묻는 질문', care: '관리·주의', closing: '마무리' };

  function render(m, photos) {
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
    const h = m.hero || {};
    return [h.eyebrow, h.headline, h.subcopy, ...(h.badges || []),
      ...m.sections.flatMap(x => [x.title, x.lead, ...x.items.flatMap(i => [i.title, i.text])]), ...m.specs.map(s => s.v)].filter(Boolean);
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
    // 사진 칸은 그 사진이 들어갈 섹션이 있을 때만 점검한다
    const usedSlots = [true, m.sections.some(x => x.kind === 'points' || x.kind === 'detail'), m.specs.length > 0];
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

  // 예전 양식으로 만든 상세페이지(v: 2가 아님)는 AI로 새로 만든다
  const isCurrent = m => m?.v === 2 && Array.isArray(m.sections);

  return { THEMES, SLOT_LABELS, KIND_LABELS, fromAI, isCurrent, render, readText, setPath, check, exportPng };
})();
