// 상세페이지 이미지: 판매 콘텐츠의 상세페이지 구성안 5블록과 상품 사진을 고정 서식에 배치한다.
// 가로 860px로 그리고, 내려받을 때는 2배(1720px) 해상도의 PNG로 저장한다.
const DetailPage = (() => {
  const WIDTH = 860;
  const THEMES = {
    navy: { label: '네이비', main: '#1e3a5f', soft: '#eef3f8' },
    green: { label: '그린', main: '#2f5d50', soft: '#edf5f1' },
    coral: { label: '코랄', main: '#b5503c', soft: '#fbf0ec' },
  };
  const SLOT_LABELS = ['대표 사진', '강점 사진', '규격·구성 사진'];

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // [일반 정보]·[입력 정보]는 분석용 표시라 상세페이지에서는 지운다. [확인 필요]는 사용자가 확인하도록 남긴다.
  const clean = t => String(t || '').replace(/\s*[[(](일반|입력) ?정보[\])]/g, '').trim();
  const sentences = t => clean(t).split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(Boolean);
  const VERIFY_RE = /\s*[[(]확인 ?필요[\])]/g;

  // 구성안의 블록을 이름으로 찾는다. 이름이 다르면 순서로 찾는다.
  function block(detail, keyword, index) {
    return detail.find(b => b.section.includes(keyword)) || detail[index] || { content: '' };
  }

  function buildModel(product, content, ai) {
    const d = content.detail_page || [];
    const hero = block(d, '대표', 0);
    const worry = block(d, '고민', 1);
    const strength = block(d, '강점', 2);
    const guide = block(d, '사용', 4);
    const points = (ai.selling_points || []).map(x => clean(x.point)).filter(Boolean);
    return {
      theme: 'navy',
      title: clean(content.product_names?.[0]?.name) || product.name,
      hero: sentences(hero.content).slice(0, 2).join(' '),
      worriesTitle: '이런 고민 있으셨나요?',
      worries: sentences(worry.content).slice(0, 4),
      strengthsTitle: '그래서 이렇게 만들었습니다',
      strengths: (points.length ? points : sentences(strength.content)).slice(0, 4),
      // 규격·인증은 AI 문장이 아니라 사용자가 입력한 값만 쓴다
      specs: [['재질', product.material], ['크기', product.size], ['구성품', product.components], ['인증', product.certification]]
        .filter(([, v]) => v).map(([k, v]) => ({ k, v })),
      guideTitle: '사용 안내 · 주의사항',
      guide: sentences(guide.content).slice(0, 5),
    };
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

  function render(m, photos) {
    const t = THEMES[m.theme] || THEMES.navy;
    return `<div class="dp" style="--dp-main:${t.main};--dp-soft:${t.soft};width:${WIDTH}px">
      <section class="dp-hero">
        ${photo(photos, 0)}
        <div class="dp-hero-text">
          ${text('title', m.title, 'h1')}
          ${text('hero', m.hero, 'p')}
        </div>
      </section>
      ${m.worries.length ? `<section class="dp-sec dp-soft">
        ${text('worriesTitle', m.worriesTitle, 'h2')}
        <ul class="dp-worries">${m.worries.map((w, i) => `<li>${text(`worries.${i}`, w)}</li>`).join('')}</ul>
      </section>` : ''}
      ${m.strengths.length ? `<section class="dp-sec">
        ${text('strengthsTitle', m.strengthsTitle, 'h2')}
        <ol class="dp-points">${m.strengths.map((s, i) => `<li><span class="dp-num">${String(i + 1).padStart(2, '0')}</span>${text(`strengths.${i}`, s)}</li>`).join('')}</ol>
        ${photo(photos, 1)}
      </section>` : ''}
      ${m.specs.length ? `<section class="dp-sec dp-soft">
        <h2>제품 정보</h2>
        <table class="dp-specs">${m.specs.map((s, i) => `<tr><th>${esc(s.k)}</th><td>${text(`specs.${i}.v`, s.v)}</td></tr>`).join('')}</table>
        ${photo(photos, 2)}
      </section>` : ''}
      ${m.guide.length ? `<section class="dp-sec">
        ${text('guideTitle', m.guideTitle, 'h2')}
        <ul class="dp-guide">${m.guide.map((g, i) => `<li>${text(`guide.${i}`, g)}</li>`).join('')}</ul>
      </section>` : ''}
    </div>`;
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
    const all = [m.title, m.hero, ...m.worries, ...m.strengths, ...m.specs.map(s => s.v), ...m.guide];
    const source = [product.name, product.description, product.material, product.size, product.components, product.certification].join(' ');
    const hasVerify = /[[(]확인 ?필요[\])]/; // 전역 플래그 없는 정규식이라 test를 반복해도 안전하다
    return {
      verify: all.filter(t => hasVerify.test(t)).length,
      risky: RISKY_WORDS.filter(w => !source.includes(w) && all.some(t => t.includes(w))),
      emptyPhotos: SLOT_LABELS.filter((_, i) => !photos[i]),
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

  return { THEMES, SLOT_LABELS, buildModel, render, readText, setPath, check, exportPng };
})();
