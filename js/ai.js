// AI로 상품을 분석한다. 빌드 도구 없이 브라우저에서 바로 실행되도록 HTTP로 직접 호출한다.
// - Claude: Anthropic API (API 키 필요)
// - Qwen: 내 컴퓨터의 Ollama (임시 테스트용, 무료·키 불필요, 사진·PDF는 반영 안 됨)
// - 무료 AI(Cloudflare): 배포한 사이트용. worker/worker.js를 거쳐 Cloudflare Workers AI를 쓴다. (키 불필요, 하루 사용량 제한)
const AI = (() => {
  const MODEL = 'claude-opus-5-5';
  const KEY_STORE = 'sellhelper.apiKey';
  const PROVIDER_STORE = 'sellhelper.provider';
  const QWEN_MODEL_STORE = 'sellhelper.qwenModel';
  const OLLAMA_URL = 'http://localhost:11434';
  const QWEN_DEFAULT = 'qwen3:8b'; // 4b보다 느리지만 리뷰·경쟁상품 분석이 확실히 나아 기본값으로 둔다
  const QWEN_DOC_CHARS = 12000; // 작은 모델의 입력 한도를 고려한 업로드 자료 글자 수 상한
  let sessionKey = '';

  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };

  // 기본값이 qwen3:4b이던 때 저장된 설정을 한 번만 새 기본값으로 바꾼다.
  // 이후 사용자가 직접 4b를 고르면 그대로 둔다.
  if (read('sellhelper.qwenDefaultV2', '') !== 'done') {
    if (read(QWEN_MODEL_STORE, '') === 'qwen3:4b') write(QWEN_MODEL_STORE, QWEN_DEFAULT);
    write('sellhelper.qwenDefaultV2', 'done');
  }

  const WORKER_URL = (typeof CONFIG !== 'undefined' && CONFIG.WORKER_URL || '').replace(/\/+$/, '');
  const CLOUD_MODEL_LABEL = 'Gemma 4 (Cloudflare 무료 AI)';
  // Worker 주소가 설정된 사이트는 처음 방문자에게 무료 AI를 기본으로 쓴다.
  function getProvider() {
    const p = read(PROVIDER_STORE, WORKER_URL ? 'cloud' : 'claude');
    return p === 'cloud' && !WORKER_URL ? 'claude' : p;
  }
  function hasCloud() { return !!WORKER_URL; }
  function getQwenModel() { return read(QWEN_MODEL_STORE, QWEN_DEFAULT); }
  function setProvider(provider, qwenModel) {
    write(PROVIDER_STORE, provider);
    write(QWEN_MODEL_STORE, (qwenModel || '').trim() || QWEN_DEFAULT);
  }
  function isReady() { return getProvider() !== 'claude' || !!getKey(); }
  function label() {
    const p = getProvider();
    return p === 'qwen' ? `Qwen ${getQwenModel()} (Ollama)` : p === 'cloud' ? CLOUD_MODEL_LABEL : 'Claude';
  }

  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || sessionKey; } catch { return sessionKey; }
  }
  function setKey(key, remember) {
    sessionKey = key;
    try {
      if (remember && key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch { /* 저장소를 쓸 수 없으면 이번 세션에만 보관 */ }
  }
  function isRemembered() {
    try { return !!localStorage.getItem(KEY_STORE); } catch { return false; }
  }

  const str = { type: 'string' };
  const strList = { type: 'array', items: str };
  // 반드시 채워야 하는 목록. 작은 모델이 "반복하지 말라"는 지시를 따르다 빈 배열로 비우는 것을 막는다.
  const filled = schema => ({ ...schema, minItems: 1 });
  const scored = {
    type: 'object',
    properties: { score: { type: 'integer' }, reason: str },
    required: ['score', 'reason'],
    additionalProperties: false,
  };
  const pointWithEvidence = {
    type: 'array',
    items: {
      type: 'object',
      properties: { point: str, evidence: str },
      required: ['point', 'evidence'],
      additionalProperties: false,
    },
  };
  const SCHEMA = {
    type: 'object',
    properties: {
      summary: str,
      features: filled(strList),
      strengths: filled(strList),
      weaknesses: filled(strList),
      selling_points: filled(pointWithEvidence),
      targets: filled({
        type: 'array',
        items: {
          type: 'object',
          properties: { segment: str, reason: str },
          required: ['segment', 'reason'],
          additionalProperties: false,
        },
      }),
      marketability: str,
      differentiation: filled(strList),
      risks: filled({
        type: 'array',
        items: {
          type: 'object',
          properties: { risk: str, improvement: str },
          required: ['risk', 'improvement'],
          additionalProperties: false,
        },
      }),
      scores: {
        type: 'object',
        properties: { market: scored, compete: scored, diff: scored, risk: scored },
        required: ['market', 'compete', 'diff', 'risk'],
        additionalProperties: false,
      },
      missing_info: strList,
      competition: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: str, strengths: strList, weaknesses: strList },
              required: ['name', 'strengths', 'weaknesses'],
              additionalProperties: false,
            },
          },
          review_insights: {
            type: 'array',
            items: {
              type: 'object',
              properties: { complaint: str, evidence: str, improvement: str },
              required: ['complaint', 'evidence', 'improvement'],
              additionalProperties: false,
            },
          },
          review_positives: pointWithEvidence,
          position: str,
        },
        required: ['items', 'review_insights', 'review_positives', 'position'],
        additionalProperties: false,
      },
    },
    required: ['summary', 'features', 'strengths', 'weaknesses', 'selling_points', 'targets', 'marketability',
      'differentiation', 'risks', 'scores', 'missing_info', 'competition'],
    additionalProperties: false,
  };

  // 사진을 AI에 보낼 때만 붙이는 항목: 사진으로 본 제품의 좋은 점·아쉬운 점·사진 개선 팁
  const PHOTO_REVIEW = {
    type: 'object',
    properties: { good: strList, bad: strList, tips: strList },
    required: ['good', 'bad', 'tips'],
    additionalProperties: false,
  };
  const PHOTO_SCHEMA = {
    ...SCHEMA,
    properties: { ...SCHEMA.properties, photo_review: PHOTO_REVIEW },
    required: [...SCHEMA.required, 'photo_review'],
  };
  const PHOTO_RULE = `

[첨부 사진 검토]
상품 사진이 함께 왔습니다. 사진을 직접 보고 photo_review를 채우세요.
- good: 사진에서 실제로 보이는 이 제품의 좋은 점 1~3개 (디자인, 색감, 마감 상태, 구성, 크기감 등)
- bad: 사진에서 보이는 아쉬운 점이나 구매자가 걱정할 만한 점 1~3개. 입력한 설명과 사진이 다르게 보이면(예: 원목이라 했는데 플라스틱처럼 보임) 꼭 씁니다.
- tips: 판매용 사진을 더 좋게 만드는 구체적인 방법 1~3개 (배경, 조명, 각도, 크기 비교 소품, 사용 장면 등)
- 모든 문장은 "사진상"으로 본 판단입니다. 무게, 내구성, 냄새, 촉감, 실제 품질처럼 사진으로 알 수 없는 것은 쓰지 마세요.
- 사진에 보이지 않는 것을 지어내지 마세요. 사진이 흐리거나 제품이 잘 안 보이면 bad와 tips에 그렇게 씁니다.`;

  const SYSTEM = `당신은 온라인 판매를 준비하는 예비창업자와 소상공인을 돕는 상품 분석가입니다.
사용자가 입력한 상품 정보(사진, 설명, 재질, 크기, 구성품, 인증 정보, 카테고리, 가격·비용)를 바탕으로, 이 상품군에 대한 당신의 일반 지식을 더해 판매 가능성을 분석합니다.
입력 정보를 여러 항목에 되풀이해 옮겨 적는 것은 분석이 아닙니다. 입력 정보에서 출발해 "그래서 구매자와 판매자에게 어떤 의미인지", "이런 종류의 상품에서 보통 무엇이 문제가 되는지"까지 생각을 넓혀 쓰세요.

두 종류의 근거를 구분해서 씁니다:
1) 입력 정보: 사용자가 입력한 이 상품의 사실. 표시 없이 씁니다.
2) 일반 정보: 이 카테고리·소재·상품 유형에 대해 일반적으로 알려진 특성, 구매자가 흔히 걱정하는 점, 흔한 불만, 관리 방법, 관련 규제나 주의사항, 판매 시 흔한 어려움. 이런 문장 끝에는 [일반 정보]를 붙입니다. 예: "원목 완구는 습기에 오래 노출되면 갈라지거나 곰팡이가 생길 수 있습니다 [일반 정보]"

원칙:
- 일반 정보는 상품군 전체에 대한 일반적인 경향으로만 쓰고, 이 상품이 그렇다고 단정하지 마세요.
- 구체적인 시장 규모, 판매량, 통계 수치, 실제 경쟁 브랜드명이나 경쟁상품 가격은 일반 정보로도 지어내지 마세요.
- 인증은 [인증 정보]에 적힌 것만 이 상품이 받았다고 쓰세요. 입력되지 않은 인증, 성능, 효과, 내구성(예: "KC 인증 완료", "10년 내구성")을 이 상품의 사실로 쓰지 마세요. 단, "이 상품군은 일반적으로 KC 인증 대상입니다 [일반 정보]"처럼 확인해야 할 규제를 알려 주는 것은 좋습니다.
- 이 상품의 품질·성능·효과처럼 이 상품에 대한 내용인데 입력 정보로 확인되지 않는 것은 문장 끝에 [확인 필요]를 붙이세요.
- 시장 수요처럼 확실하지 않은 판단은 "~일 가능성이 있습니다"처럼 추정임을 드러내세요.
- 경쟁상품 분석(competition)은 사용자가 직접 입력한 경쟁상품 정보, 리뷰, 업로드 자료에 있는 내용만 근거로 쓰세요. 자료에 없는 경쟁상품을 추가하거나 가격·평점·판매량을 추정해 채우지 마세요.
- 가격 비교는 [계산된 가격 비교]의 결론과 숫자만 그대로 쓰세요. 직접 계산하거나 "비싸다/저렴하다"를 다르게 판단하지 마세요. 가격 비교는 입력 정보이므로 [일반 정보]를 붙이지 마세요. [계산된 가격 비교]가 없으면 경쟁상품과의 가격 비교를 쓰지 마세요.
  - items: 입력된 경쟁상품마다 장점과 단점을 정리합니다. 근거가 없으면 빈 배열로 둡니다.
  - review_insights: 제공된 리뷰에서 반복되는 불만사항을 뽑고, evidence에 근거가 된 리뷰 내용을 짧게 요약하며, improvement에 내 상품의 개선점을 씁니다. 리뷰가 없으면 빈 배열로 둡니다.
  - review_positives: 제공된 리뷰에서 반복되는 만족 요인(구매자가 좋아한 점)을 뽑고, evidence에 근거가 된 리뷰 내용을 짧게 요약합니다. 리뷰가 없으면 빈 배열로 둡니다.
  - position: 경쟁상품 대비 내 상품의 경쟁력을 2~3문장으로 평가합니다. 경쟁상품 정보가 전혀 없으면 "경쟁상품 정보가 입력되지 않아 비교할 수 없습니다."라고 씁니다.
- 경쟁상품 정보가 있으면 경쟁력(compete) 점수에 반영하고, 없으면 상품 자체의 특성과 카테고리의 일반적 경쟁 강도에 근거한 추정임을 이유에 밝히세요.
- 사진이 있으면 사진에서 실제로 보이는 것만 근거로 쓰고, 보이지 않는 품질은 단정하지 마세요.
- 코딩이나 마케팅을 모르는 사람도 이해할 수 있게 쉬운 한국어로, 항목마다 1~2문장으로 간결하게 쓰세요.
- 광고 문구, SNS 홍보글, 상세페이지 문구는 작성하지 마세요.

점수 기준 (0~100 정수, 입력 정보에 기반한 참고용 추정치):
- market(시장성): 수요가 있을 만한 상품인지, 온라인으로 팔기 적합한지
- compete(경쟁력): 같은 카테고리의 일반적인 상품들과 비교해 내세울 점이 있는지
- diff(차별화 가능성): 다른 상품과 구별되는 요소를 만들 여지가 있는지
- risk(판매 위험도): 높을수록 위험. 파손·반품·인증·계절성·재고·법규 등 위험 요인의 크기
정보가 부족하면 점수를 극단적으로 주지 말고 missing_info에 무엇이 더 필요한지 적으세요.

답변 항목별 작성 안내 (모든 값은 한국어 문장으로 씁니다. 항목 이름이 영어여도 내용은 영어로 쓰지 마세요):
아래 항목은 모두 안내된 개수만큼 반드시 채우세요. 빈 목록으로 두지 마세요. (경쟁상품 관련 항목만 자료가 없으면 비워 둡니다.)
항목마다 역할이 다릅니다. 같은 사실을 두 항목 이상에 같은 표현으로 쓰지 마세요. 앞 항목에 쓴 사실을 다시 다룰 때는 그 항목의 역할에 맞는 새로운 관점(구매자에게 주는 의미, 판매 시 주의점, 새로운 아이디어)만 덧붙이세요.
- summary: 이 상품을 판매해도 될지에 대한 종합 의견 2~3문장. 가장 큰 강점 하나와 가장 큰 걱정거리 하나를 함께 씁니다.
- features: 이 상품이 무엇인지 보여 주는 객관적 사실 2~4개 (재질, 크기, 구성, 가공 방식 등). 평가나 장단점은 쓰지 않습니다.
- strengths: 구매자 입장에서 이 상품을 사면 좋은 이유 2~3개. 사실을 나열하지 말고 그 사실이 구매자에게 주는 이득을 씁니다. (예: "모서리 라운드 가공" → "어린아이가 가지고 놀아도 다칠 걱정이 적음")
- weaknesses: 구매자가 아쉬워하거나 걱정할 만한 점 2~3개. 입력 정보에 단점이 없어도 이 상품군의 일반적인 약점(관리, 내구성, 가격 대비 구성, 보관 등)을 [일반 정보]로 찾아 씁니다.
- selling_points: 판매할 때 강조할 메시지 2~4개. point에 구매자의 고민과 연결한 강조점, evidence에 그 강조점을 뒷받침하는 근거(예: "인증 정보: KC 인증", "경쟁상품 리뷰의 '냄새가 심하다'는 불만")를 씁니다. 근거가 일반 정보면 끝에 [일반 정보], 근거가 없으면 "확인 필요"라고 씁니다. strengths와 같은 문장을 쓰지 마세요.
- targets: 예상 타깃 고객층 1~3개. segment에 누구인지 구체적으로(예: "첫 원목 장난감을 고르는 돌~3세 아이 부모"), reason에 그 사람들이 이 상품을 고를 이유
- marketability: 이 상품군의 수요 특성(계절성, 선물 수요, 재구매 여부, 온라인 구매 시 걱정거리 등)을 바탕으로 한 시장성과 판매 가능성 평가 2~3문장
- differentiation: 아직 이 상품에 없는, 새로 해 볼 수 있는 구체적인 차별화 아이디어 2~3개 (구성 변경, 서비스, 패키지, 정보 제공 방식 등). 이미 가진 특징을 다시 쓰지 마세요.
- risks: 판매하면서 생길 수 있는 문제 1~3개(반품, 파손, 인증·법규, 계절성, 재고, 리뷰 관리 등). risk에 위험요소, improvement에 판매자가 할 수 있는 구체적인 대응
- scores: 각 항목의 score(0~100 정수)와 reason(이 상품에 대한 점수 이유 1문장)
- missing_info: 더 정확한 분석을 위해 사용자가 추가로 알려 주면 좋은 정보

이 안내문이나 위의 점수 기준 문장을 답변에 그대로 옮겨 적지 마세요. "사용자가 입력한 정보만 근거로 분석합니다" 같은 분석 방법 설명도 쓰지 말고, 이 상품에 대한 내용만 쓰세요.`;

  function buildText(product, profit, docsInline = '') {
    const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
    return `다음 상품을 분석해 주세요.

[상품명] ${product.name}
[판매 플랫폼 > 카테고리] ${Platforms.path(product) || '입력 안 함'}
[재질] ${product.material || '입력 안 함'}
[구성품] ${product.components || '입력 안 함'}
[인증 정보] ${product.certification ? `${product.certification} - 사용자가 공식 조회로 확인함` : '없음 또는 확인 안 됨 (인증을 받았다고 쓰지 마세요)'}
[크기] ${product.size || '입력 안 함'}
[제품 설명]
${product.description}

[가격·비용, 1개 기준]
- 원가: ${won(product.cost)}${product.cost === 0 ? ' (사용자가 원가 없음으로 확인함: 직접 만든 상품·보유 재고 등)' : ''}
- 판매가: ${won(product.price)}
- 배송비(판매자 부담): ${won(product.shipping)}
- 포장비: ${won(product.packaging)}
- 판매 플랫폼: ${product.platform && product.platform !== 'custom' ? Platforms.label(product.platform) : '지정 안 함'}
- 플랫폼 수수료율: ${product.feeRate}%
- 계산된 순이익: ${won(profit.profit)} (마진율 ${profit.margin.toFixed(1)}%)

첨부 사진: ${product.photos.length}장

[경쟁상품 정보 - 사용자 직접 입력]
${product.competitors.length ? product.competitors.map((c, i) => `${i + 1}. ${c.name || '(이름 없음)'}
- 판매가: ${c.price > 0 ? won(c.price) : '입력 안 함'}
- 특징: ${c.features || '입력 안 함'}
- 소비자 리뷰:
${c.reviews || '입력 안 함'}`).join('\n\n') : '입력된 경쟁상품 없음'}
${priceComparison(product)?.text || ''}
업로드 자료: ${product.docs.length ? product.docs.map(d => d.name).join(', ') : '없음'}${docsInline}`;
  }

  // 가격 비교는 AI가 어림하지 않도록 코드로 계산해 결론까지 넘겨준다.
  const SIMILAR_PCT = 5; // 평균 대비 ±5% 이내면 '비슷한 가격'
  function priceComparison(product) {
    const st = Profit.competitorStats(product);
    if (!st) return null;
    const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
    const level = st.diffPct > SIMILAR_PCT ? 'higher' : st.diffPct < -SIMILAR_PCT ? 'lower' : 'similar';
    const overall = { higher: '경쟁상품 평균보다 비싼 편', lower: '경쟁상품 평균보다 저렴한 편', similar: '경쟁상품 평균과 비슷한 가격' }[level];
    const each = product.competitors.filter(c => c.price > 0).map(c => {
      const gap = product.price - c.price;
      const rel = gap === 0 ? '같은 가격' : `${won(Math.abs(gap))}(${Math.abs(gap / c.price * 100).toFixed(1)}%) ${gap > 0 ? '비쌈' : '저렴함'}`;
      return `- ${c.name || '(이름 없음)'} ${won(c.price)} → 내 상품이 ${rel}`;
    });
    const text = `
[계산된 가격 비교 - 계산이 끝난 결과입니다. 가격 비교는 이 내용만 그대로 쓰고 직접 다시 계산하지 마세요]
- 내 판매가 ${won(product.price)}, 경쟁상품 평균 ${won(st.avg)} (범위 ${won(st.min)}~${won(st.max)})
- 결론: 내 상품은 ${overall}입니다 (평균 대비 ${st.diffPct >= 0 ? '+' : ''}${st.diffPct.toFixed(1)}%)
${each.join('\n')}
`;
    return { text, level };
  }

  // AI가 계산 결과와 반대로 "경쟁상품보다 비싸다/저렴하다"고 쓴 문장을 찾는다.
  const EXPENSIVE_RE = /(경쟁\s?상품|경쟁사|다른 상품)[^.。]{0,20}(비싸|비쌈|높[아은게])|가격이 (더 |상대적으로 )?(높|비싸)/;
  const CHEAP_RE = /(경쟁\s?상품|경쟁사|다른 상품)[^.。]{0,20}(저렴|싸[서고다]|낮[아은게])|가격이 (더 |상대적으로 )?(낮|저렴)/;
  function checkPriceClaims(out, product) {
    const cmp = priceComparison(product);
    if (!cmp) return out;
    const texts = {
      '종합 의견': [out.summary], '장점·단점': [...out.strengths, ...out.weaknesses],
      '시장성과 판매 가능성': [out.marketability], '위험요소': out.risks.flatMap(x => [x.risk, x.improvement]),
      '경쟁력 평가': [out.competition.position], '점수 이유': Object.values(out.scores).map(x => x.reason),
    };
    const wrong = Object.entries(texts).filter(([, list]) => list.some(t =>
      (cmp.level !== 'higher' && EXPENSIVE_RE.test(t)) || (cmp.level !== 'lower' && CHEAP_RE.test(t)))).map(([k]) => `'${k}'`);
    if (wrong.length) {
      const actual = { higher: '평균보다 비싼 편', lower: '평균보다 저렴한 편', similar: '평균과 비슷한 가격' }[cmp.level];
      out.notices = [...out.notices, `${wrong.join(', ')} 항목의 가격 비교가 실제 계산과 다를 수 있습니다. 계산 결과 내 상품은 경쟁상품 ${actual}입니다. 경쟁상품 분석의 가격 표를 기준으로 판단하고, 필요하면 수정 버튼으로 고쳐 주세요.`];
    }
    return out;
  }

  function buildContent(product, profit) {
    const images = product.photos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.mediaType, data: p.data },
    }));
    const docs = product.docs.map(d => d.kind === 'pdf'
      ? { type: 'document', title: d.name, source: { type: 'base64', media_type: 'application/pdf', data: d.data } }
      : { type: 'document', title: d.name, source: { type: 'text', media_type: 'text/plain', data: d.text } });
    return [...docs, ...images, { type: 'text', text: buildText(product, profit) }];
  }

  async function analyze(product, profit, signal) {
    const p = getProvider();
    const out = await (p === 'qwen' ? analyzeQwen(product, profit, signal)
      : p === 'cloud' ? analyzeCloud(product, profit, signal)
      : analyzeClaude(product, profit, signal));
    return checkPriceClaims(out, product);
  }

  async function analyzeClaude(product, profit, signal) {
    const hasPhotos = product.photos.length > 0;
    const { parsed, model } = await requestClaude(hasPhotos ? SYSTEM + PHOTO_RULE : SYSTEM, buildContent(product, profit),
      hasPhotos ? PHOTO_SCHEMA : SCHEMA, signal);
    return normalize(parsed, model, []);
  }

  // Claude에 한 번 요청하고 JSON 응답을 돌려준다. (분석·판매 콘텐츠 공용)
  async function requestClaude(system, content, schema, signal) {
    const key = getKey();
    if (!key) throw new AIError('no-key', 'AI 설정에서 API 키를 먼저 입력해 주세요.');

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2026-10-21',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16000,
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
          system,
          messages: [{ role: 'user', content }],
        }),
      });
    } catch {
      if (signal?.aborted) throw cancelled();
      throw new AIError('network', '인터넷 연결을 확인해 주세요. AI 서버에 연결하지 못했습니다.');
    }

    const body = await res.json().catch(() => null);
    if (signal?.aborted) throw cancelled();
    if (!res.ok) {
      const msg = body?.error?.message || '';
      if (res.status === 401) throw new AIError('auth', 'API 키가 올바르지 않습니다. AI 설정에서 키를 확인해 주세요.');
      if (res.status === 429) throw new AIError('rate', '요청이 많아 잠시 제한되었습니다. 1분 뒤 다시 시도해 주세요.');
      if (res.status === 413) throw new AIError('size', '사진 용량이 너무 큽니다. 사진 수를 줄여 주세요.');
      if (res.status >= 500) throw new AIError('server', 'AI 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.');
      throw new AIError('api', `AI 요청이 거절되었습니다. (${res.status}) ${msg}`);
    }
    if (body.stop_reason === 'refusal') {
      throw new AIError('refusal', 'AI가 이 상품에 대한 요청을 진행하지 않았습니다. 입력 내용을 확인해 주세요.');
    }
    if (body.stop_reason === 'max_tokens') {
      throw new AIError('truncated', 'AI 답변이 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요.');
    }
    const textBlock = body.content.find(b => b.type === 'text');
    let parsed;
    try { parsed = JSON.parse(textBlock.text); } catch {
      throw new AIError('parse', 'AI 응답을 읽지 못했습니다. 다시 시도해 주세요.');
    }
    return { parsed, model: `Claude (${body.model || MODEL})` };
  }

  // Ollama 기본 API. format에 JSON 스키마를 주면 그 형식으로만 답한다.
  async function analyzeQwen(product, profit, signal) {
    const { notices, docsInline } = textOnlyInput(product, 'Qwen 테스트 모드');
    const { parsed, model: label } = await requestQwen(SYSTEM, buildText(product, profit, docsInline), SCHEMA, signal);
    return normalize(parsed, label, notices);
  }

  // 무료 AI(Gemma 4)는 사진도 읽는다. 대표 사진부터 최대 3장을 줄여서 함께 보낸다.
  async function analyzeCloud(product, profit, signal) {
    const { notices, docsInline } = textOnlyInput(product, '무료 AI(Cloudflare)', { photos: true });
    const images = [];
    for (const p of product.photos.slice(0, 3)) {
      try { images.push(await smallPhoto(p.url, 768)); } catch { /* 못 읽은 사진은 빼고 보낸다 */ }
    }
    const hasPhotos = images.length > 0;
    const { parsed, model, imagesUsed } = await requestCloud(hasPhotos ? SYSTEM + PHOTO_RULE : SYSTEM,
      buildText(product, profit, docsInline), hasPhotos ? PHOTO_SCHEMA : SCHEMA, signal, images);
    if (product.photos.length && !imagesUsed) notices.push('무료 AI가 이번에는 상품 사진을 읽지 못해 입력한 글만으로 분석했습니다.');
    else if (product.photos.length > images.length) notices.push(`사진은 앞의 ${images.length}장만 분석에 반영되었습니다.`);
    const out = normalize(parsed, model, notices);
    if (!imagesUsed) delete out.photo_review;
    return out;
  }

  // AI에 보낼 사진을 작게 줄인다. (긴 변 maxSide px, JPEG data URL)
  function smallPhoto(url, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // 사진·PDF를 못 읽는 모드용: 텍스트 자료만 앞부분을 잘라 프롬프트에 넣고, 빠진 자료를 알린다.
  function textOnlyInput(product, modeName, can = {}) {
    const notices = [];
    if (product.photos.length && !can.photos) notices.push(`${modeName}에서는 상품 사진이 분석에 반영되지 않았습니다.`);
    const pdfs = product.docs.filter(d => d.kind === 'pdf');
    if (pdfs.length) notices.push(`PDF 자료(${pdfs.map(d => d.name).join(', ')})는 ${modeName}에서 반영되지 않았습니다.`);

    let budget = QWEN_DOC_CHARS;
    let docsInline = '';
    for (const d of product.docs.filter(x => x.kind === 'text')) {
      const part = d.text.slice(0, Math.max(0, budget));
      if (part.length < d.text.length) {
        notices.push(`업로드 자료 '${d.name}'가 길어 앞부분 ${part.length.toLocaleString('ko-KR')}자만 반영되었습니다. (전체 ${d.text.length.toLocaleString('ko-KR')}자)`);
      }
      if (part) docsInline += `\n\n[업로드 자료: ${d.name}]\n${part}`;
      budget -= part.length;
    }
    return { notices, docsInline };
  }

  // Cloudflare Worker(worker/worker.js)에 한 번 요청하고 JSON 응답을 돌려준다. (분석·판매 콘텐츠 공용)
  async function requestCloud(system, text, schema, signal, images = []) {
    if (!WORKER_URL) throw new AIError('no-worker', '무료 AI 주소(js/config.js의 WORKER_URL)가 설정되지 않았습니다.');
    let res, data;
    try {
      res = await fetch(WORKER_URL, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(images.length ? { system, text, schema, images } : { system, text, schema }),
      });
      data = await res.json().catch(() => null);
    } catch {
      if (signal?.aborted) throw cancelled();
      throw new AIError('network', '무료 AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.');
    }
    if (signal?.aborted) throw cancelled();
    if (!res.ok || !data?.result) {
      if (res.status === 429) throw new AIError('rate', data?.message || '오늘 무료 AI 사용량을 모두 썼습니다. 내일 다시 시도해 주세요.');
      throw new AIError(data?.error || 'api', data?.message || `무료 AI 요청이 실패했습니다. (${res.status})`);
    }
    return { parsed: data.result, model: CLOUD_MODEL_LABEL, imagesUsed: data.imagesUsed === true };
  }

  // Ollama 기본 API에 한 번 요청하고 JSON 응답을 돌려준다. (분석·판매 콘텐츠 공용)
  async function requestQwen(system, text, schema, signal) {
    const model = getQwenModel();
    const body = {
      model,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0.3, num_ctx: 16384 },
      messages: [
        { role: 'system', content: `${system}\n\n반드시 주어진 JSON 형식으로만, 모든 내용을 한국어로 답하세요.` },
        { role: 'user', content: text },
      ],
    };
    const call = b => fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), signal,
    });

    let res, data;
    try {
      res = await call(body);
      data = await res.json().catch(() => null);
      // 사고 모드를 지원하지 않는 모델(qwen2.5 등)은 think 옵션 없이 다시 요청
      if (!res.ok && /think/i.test(data?.error || '')) {
        delete body.think;
        res = await call(body);
        data = await res.json().catch(() => null);
      }
    } catch {
      if (signal?.aborted) throw cancelled();
      throw new AIError('ollama-offline', 'Ollama에 연결하지 못했습니다. Ollama 앱이 실행 중인지, 브라우저 접근 허용(OLLAMA_ORIGINS) 설정을 했는지 확인해 주세요.');
    }
    if (signal?.aborted) throw cancelled();
    if (!res.ok) {
      const msg = data?.error || '';
      if (res.status === 404 || /not found/i.test(msg)) {
        throw new AIError('ollama-model', `'${model}' 모델이 설치되어 있지 않습니다. 터미널에서 ollama pull ${model} 을 실행해 주세요.`);
      }
      throw new AIError('api', `Qwen 요청이 실패했습니다. (${res.status}) ${msg}`);
    }
    let parsed;
    try { parsed = JSON.parse(data.message.content); } catch {
      throw new AIError('parse', 'Qwen 응답을 읽지 못했습니다. 다시 시도해 주세요.');
    }
    return { parsed, model: `Qwen ${model} (Ollama, 테스트용)` };
  }

  // 응답 형식을 화면이 기대하는 모양으로 맞춘다. 작은 모델은 항목을 빠뜨릴 수 있어 빈 값으로 채운다.
  function normalize(r, model, notices) {
    const s = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const arr = v => (Array.isArray(v) ? v : []);
    const strs = v => arr(v).map(s).filter(Boolean);
    // 점수가 빠지면 0점(위험도는 '위험 없음')으로 오해되므로 중립값 50점으로 두고 알린다.
    const NAMES = { market: '시장성', compete: '경쟁력', diff: '차별화 가능성', risk: '판매 위험도' };
    const missing = [];
    const score = key => {
      const o = r?.scores?.[key];
      const n = Number(o?.score);
      if (o?.score == null || o.score === '' || !Number.isFinite(n)) {
        missing.push(NAMES[key]);
        return { score: 50, reason: 'AI가 점수를 주지 않아 중립값 50점으로 처리했습니다.' };
      }
      return { score: Math.max(0, Math.min(100, Math.round(n))), reason: s(o.reason) || '근거가 제시되지 않았습니다.' };
    };
    const scores = { market: score('market'), compete: score('compete'), diff: score('diff'), risk: score('risk') };
    if (missing.length) notices = [...notices, `AI 응답에 ${missing.join(', ')} 점수가 없어 50점(중립)으로 처리했습니다. 종합 판정을 신뢰하기 어려우니 다시 분석해 보세요.`];
    const c = r?.competition || {};
    const points = v => arr(v).map(x => ({ point: s(x?.point), evidence: s(x?.evidence) || '확인 필요' })).filter(x => x.point);
    const out = {
      summary: s(r?.summary),
      features: strs(r?.features),
      strengths: strs(r?.strengths),
      weaknesses: strs(r?.weaknesses),
      selling_points: points(r?.selling_points),
      targets: arr(r?.targets).map(t => ({ segment: s(t?.segment), reason: s(t?.reason) })).filter(t => t.segment),
      marketability: s(r?.marketability),
      differentiation: strs(r?.differentiation),
      risks: arr(r?.risks).map(x => ({ risk: s(x?.risk), improvement: s(x?.improvement) })).filter(x => x.risk),
      scores,
      incomplete: missing.length > 0,
      missing_info: strs(r?.missing_info),
      competition: {
        items: arr(c.items).map(i => ({ name: s(i?.name), strengths: strs(i?.strengths), weaknesses: strs(i?.weaknesses) })).filter(i => i.name),
        review_insights: arr(c.review_insights).map(i => ({ complaint: s(i?.complaint), evidence: s(i?.evidence), improvement: s(i?.improvement) })).filter(i => i.complaint),
        review_positives: points(c.review_positives),
        position: s(c.position),
      },
      model,
      notices,
    };
    // 사진 검토: 사진을 함께 보낸 분석에만 있다.
    const pr = r?.photo_review;
    if (pr && typeof pr === 'object') {
      out.photo_review = { good: strs(pr.good), bad: strs(pr.bad), tips: strs(pr.tips) };
      if (!out.photo_review.good.length && !out.photo_review.bad.length && !out.photo_review.tips.length) delete out.photo_review;
    }
    const EMPTY_CHECK = { '주요 특징': out.features, '장점': out.strengths, '단점': out.weaknesses, '강조할 장점과 근거': out.selling_points,
      '타깃 고객층': out.targets, '차별화 요소': out.differentiation, '위험요소': out.risks };
    const empty = Object.entries(EMPTY_CHECK).filter(([, v]) => !v.length).map(([k]) => `'${k}'`);
    if (empty.length) out.notices = [...out.notices, `${empty.join(', ')} 항목을 AI가 채우지 않았습니다. 다시 분석해 보세요.`];
    const bad = qualityProblems(out);
    if (bad.length) {
      out.notices = [...out.notices, `${bad.join(', ')} 항목에 영어 문장이나 분석 지시문을 옮겨 적은 내용이 섞여 있습니다. 다시 분석하거나 더 큰 모델을 사용해 보세요.`];
    }
    return out;
  }

  // 작은 모델이 영어로 쓰거나 프롬프트 문장을 베껴 쓴 항목을 찾는다. (경쟁상품 이름은 영문일 수 있어 검사하지 않음)
  const COPIED_PHRASES = ['수요가 있을 만한 상품인지', '온라인으로 팔기 적합한지', '내세울 점이 있는지',
    '구별되는 요소를 만들 여지가 있는지', '근거로 분석합니다', '작성 안내', 'key points'];
  function qualityProblems(a) {
    const fields = {
      '종합 의견': [a.summary],
      '주요 특징': a.features,
      '장점·단점': [...a.strengths, ...a.weaknesses],
      '강조할 장점과 근거': a.selling_points.flatMap(x => [x.point, x.evidence]),
      '타깃 고객층': a.targets.flatMap(t => [t.segment, t.reason]),
      '시장성과 판매 가능성': [a.marketability],
      '차별화 요소': a.differentiation,
      '위험요소': a.risks.flatMap(x => [x.risk, x.improvement]),
      '점수 이유': Object.values(a.scores).map(x => x.reason),
    };
    const english = t => {
      const latin = (t.match(/[A-Za-z]/g) || []).length;
      const hangul = (t.match(/[가-힣]/g) || []).length;
      return latin >= 15 && latin > hangul;
    };
    const copied = t => COPIED_PHRASES.some(p => t.toLowerCase().includes(p.toLowerCase()));
    return Object.entries(fields)
      .filter(([, texts]) => texts.some(t => t && (english(t) || copied(t))))
      .map(([name]) => `'${name}'`);
  }

  /* ---------- 판매 콘텐츠 (상품명·키워드·상세페이지 구성안·홍보문구) ---------- */
  // 분석과 따로 요청한다. 사용자가 확인·수정한 분석 결과를 바탕으로 만든다.
  const DETAIL_SECTIONS = ['대표 사진과 핵심 장점', '구매자의 고민', '제품 강점', '근거·규격·인증', '사용 안내·주의사항'];
  const CONTENT_SCHEMA = {
    type: 'object',
    properties: {
      product_names: filled({
        type: 'array',
        items: { type: 'object', properties: { name: str, reason: str }, required: ['name', 'reason'], additionalProperties: false },
      }),
      keywords: filled(strList),
      detail_page: filled({
        type: 'array',
        items: { type: 'object', properties: { section: str, title: str, content: str, evidence: str }, required: ['section', 'title', 'content', 'evidence'], additionalProperties: false },
      }),
      promo_copies: filled({
        type: 'array',
        items: { type: 'object', properties: { channel: str, text: str }, required: ['channel', 'text'], additionalProperties: false },
      }),
    },
    required: ['product_names', 'keywords', 'detail_page', 'promo_copies'],
    additionalProperties: false,
  };

  const CONTENT_SYSTEM = `당신은 온라인 판매를 처음 하는 예비창업자와 소상공인을 위해 판매 콘텐츠 초안을 쓰는 도우미입니다.
사용자가 입력한 상품 정보와, 사용자가 확인한 분석 결과를 바탕으로 상품명 후보, 검색 키워드, 상세페이지 구성안, 홍보문구를 씁니다.

지켜야 할 규칙:
- 상품의 사실(재질, 크기, 구성, 인증, 기능)은 입력된 상품 정보에 있는 것만 씁니다. 인증은 [인증 정보]에 적힌 것만 씁니다.
- 입력 정보로 확인되지 않은 성능·효과·내구성을 쓰지 마세요. 꼭 필요하면 문장 끝에 [확인 필요]를 붙입니다.
- 과장되거나 광고 규정상 문제가 될 수 있는 표현을 쓰지 마세요: 최고, 최상, 1위, 최초, 유일, 완벽, 100%, 무해, 무독성, 부작용 없음, 절대, 치료, 예방, 의학적 효능. (입력된 인증 정보에 그 표현이 그대로 있는 경우만 예외)
- 경쟁상품을 깎아내리거나 특정 브랜드를 언급하지 마세요. 가격 비교는 [계산된 가격 비교]가 있을 때 그 결론만 씁니다.
- 쉬운 한국어로, 실제 판매 페이지에 바로 옮겨 쓸 수 있게 자연스럽게 씁니다.

항목별 작성 안내:
- product_names: 오픈마켓 상품명 후보 3개. 구매자가 검색할 핵심 단어 + 특징 + 구성/규격 순서로, 50자 이내. 브랜드명은 넣지 않습니다. reason에 이렇게 지은 이유 1문장.
- keywords: 구매자가 검색창에 입력할 만한 검색 키워드 8~10개. 한 단어 또는 짧은 구절. 상품명에 쓴 단어 외에 용도, 대상, 상황(선물 등)도 포함합니다.
- detail_page: 상세페이지를 위에서 아래로 보여 줄 순서대로 정확히 5개 블록. section은 순서대로 "${DETAIL_SECTIONS.join('", "')}"를 그대로 씁니다.
  title에는 상세페이지에 크게 보일 그 블록의 제목을 이 상품에 맞춰 15자 안팎으로 씁니다. 예) 수납 트레이의 고민 블록 "책상 위, 늘 어수선하셨죠?", 쿠키의 강점 블록 "매일 아침 굽는 버터 쿠키", 화장품의 사용 안내 블록 "이렇게 바르세요".
  content에는 그 블록에 실제로 넣을 문구 2~3문장을 씁니다. evidence에는 그 내용의 근거(예: "인증 정보: KC 인증", "경쟁상품 리뷰의 '냄새가 심하다' 불만")를 씁니다.
  구매자의 고민 블록은 경쟁상품 리뷰의 불만에서, 근거·규격·인증 블록은 입력된 재질·크기·구성품·인증에서만 가져옵니다. 근거가 없으면 evidence에 "확인 필요"라고 씁니다.
- promo_copies: 정확히 3개. channel은 순서대로 "인스타그램 게시글", "검색광고 문구", "한 줄 카피"를 씁니다.
  인스타그램 게시글은 2~3문장과 해시태그 3~5개, 검색광고 문구는 제목 15자 이내와 설명 45자 이내를 " / "로 구분, 한 줄 카피는 20자 안팎의 한 문장입니다.

이 안내문을 답변에 그대로 옮겨 적지 말고, 이 상품에 맞는 내용만 쓰세요.`;

  function buildContentText(product, profit, ai) {
    const lines = (title, items) => items?.length ? `[${title}]\n${items.map(x => `- ${x}`).join('\n')}\n` : '';
    const c = ai.competition || {};
    return `${buildText(product, profit)}

=== 사용자가 확인한 분석 결과 ===
${lines('종합 의견', [ai.summary])}${lines('장점', ai.strengths)}${lines('단점', ai.weaknesses)}${lines('강조할 장점과 근거', (ai.selling_points || []).map(x => `${x.point} (근거: ${x.evidence})`))}${lines('타깃 고객층', ai.targets.map(t => `${t.segment}: ${t.reason}`))}${lines('차별화 요소', ai.differentiation)}${lines('리뷰의 만족 요인', (c.review_positives || []).map(x => x.point))}${lines('리뷰의 불만사항', (c.review_insights || []).map(x => `${x.complaint} → 개선: ${x.improvement}`))}
위 정보로 판매 콘텐츠 초안을 써 주세요.`;
  }

  async function generateContent(product, profit, ai, signal) {
    const p = getProvider();
    const request = p === 'qwen' ? requestQwen : p === 'cloud' ? requestCloud : requestClaude;
    const req = request(CONTENT_SYSTEM, buildContentText(product, profit, ai), CONTENT_SCHEMA, signal);
    const { parsed, model } = await req;
    return normalizeContent(parsed, model, product);
  }

  /* ---------- AI 상세페이지 ---------- */
  // 정해진 양식에 문장을 끼워 넣는 대신, AI가 이 상품에 맞는 상세페이지 구성(섹션 종류·순서·분량·제목)을 직접 짠다.
  // 섹션 종류: 그리는 모양이 정해져 있고(js/detail.js), 어떤 걸 몇 번째에 쓸지는 AI가 고른다.
  const DETAIL_KINDS = ['empathy', 'points', 'detail', 'scenes', 'howto', 'specs', 'faq', 'care', 'closing'];
  const DETAIL_THEMES = ['navy', 'green', 'coral', 'orange', 'pink', 'blue', 'black'];
  const DETAIL_SYSTEM = `당신은 한국 온라인 쇼핑몰(스마트스토어, 쿠팡 등)의 상세페이지를 기획하고 카피를 쓰는 전문가입니다.
주어진 상품 정보, 분석 결과, 판매 콘텐츠 초안{{PHOTO}}를 바탕으로, 이 상품만을 위한 상세페이지 전체를 설계합니다.
같은 틀을 반복하지 말고, 이 상품을 사는 사람이 무엇을 궁금해하고 무엇에 끌리는지 생각해 섹션의 종류·순서·분량을 정합니다.

[섹션 종류 kind]
- empathy: 구매자의 고민·불편에 공감. items에 구매자가 실제로 할 법한 말 3~4개(text만, title은 빈 문자열)
- points: 핵심 장점. items 3~4개. title은 장점을 한마디로(12자 안팎), text는 그 장점이 구매자에게 주는 이득과 근거 2~3문장
- detail: 소재·마감·디자인 등 가까이 들여다보는 부분. items 2~3개(title + text 1~2문장)
- scenes: 이런 분께·이런 곳에 추천. items 3~4개(title은 상황이나 사람, text는 1문장)
- howto: 사용 방법. items 3~5단계(title은 단계 이름, text는 1문장)
- specs: 제품 정보 표. 표 내용은 사용자가 입력한 값으로 자동으로 채우므로 items는 빈 배열, title만 씁니다.
- faq: 자주 묻는 질문. items 3~4개(title은 질문, text는 답 1~2문장). 입력 정보로 답할 수 없는 질문은 넣지 않습니다.
- care: 관리 방법·주의사항. items 3~5개(text만)
- closing: 마지막 구매 유도. lead에 마무리 문장 1~2문장, items는 빈 배열

[구성 규칙]
- sections는 6~9개. points와 specs는 꼭 넣고, 나머지는 이 상품에 필요한 것만 고릅니다. 같은 kind를 두 번 쓰지 않습니다.
- 순서도 상품에 맞게 정합니다. 예) 식품: points → detail → scenes → specs → care / 생활용품: empathy → points → howto → specs → faq
- 각 섹션 title은 이 상품에 맞춘 문구로 15자 안팎 (예: "샤워 후 10초면 끝", "물때 걱정, 이제 그만"). "제품 강점" 같은 뻔한 제목은 피합니다.
- lead는 섹션 제목 아래 짧은 소개 1문장(없으면 빈 문자열).
- hero: eyebrow는 상품을 한마디로 소개하는 짧은 머리말(12자 안팎), headline은 가장 큰 제목(20자 안팎), subcopy는 1~2문장, badges는 핵심 특징 2~3개(각 8자 안팎).
- theme: 상품 분위기에 맞는 색. navy(차분·신뢰), green(자연·원목·친환경), coral(따뜻함·선물), orange(식품·활기), pink(뷰티·여성), blue(디지털·청결), black(패션·고급) 중 하나.

[사실 규칙]
- 입력 정보와 분석 결과에 있는 사실만 씁니다. 수치·성능·효과·인증·수상·판매량·후기를 지어내지 마세요.
- 이 상품에 대한 내용인데 입력 정보로 확인되지 않는 것은 문장 끝에 [확인 필요]를 붙입니다.
- 가격·할인·배송 약속은 쓰지 않습니다. '최고', '1위', '완벽', '100%', '무독성', '치료', '효능' 같은 과장·규제 표현을 쓰지 않습니다.
- 사진이 있으면 사진에서 보이는 색·모양·마감을 문장에 활용하되, 보이지 않는 품질은 단정하지 않습니다.
- 모두 자연스러운 한국어로, 판매자가 그대로 올릴 수 있는 완성된 문장으로 씁니다.`;
  const DETAIL_SCHEMA = (() => {
    const str = { type: 'string' };
    const item = { type: 'object', properties: { title: str, text: str }, required: ['title', 'text'], additionalProperties: false };
    return {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: DETAIL_THEMES },
        hero: {
          type: 'object',
          properties: { eyebrow: str, headline: str, subcopy: str, badges: { type: 'array', items: str } },
          required: ['eyebrow', 'headline', 'subcopy', 'badges'],
          additionalProperties: false,
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: DETAIL_KINDS }, title: str, lead: str, items: { type: 'array', items: item } },
            required: ['kind', 'title', 'lead', 'items'],
            additionalProperties: false,
          },
        },
      },
      required: ['theme', 'hero', 'sections'],
      additionalProperties: false,
    };
  })();

  function buildDetailText(product, profit, ai) {
    const lines = (title, items) => items?.length ? `[${title}]\n${items.map(x => `- ${x}`).join('\n')}\n` : '';
    const c = ai.content || {};
    return `${buildText(product, profit)}

=== 분석 결과 ===
${lines('종합 의견', [ai.summary])}${lines('주요 특징', ai.features)}${lines('장점', ai.strengths)}${lines('단점(구매자가 걱정할 점)', ai.weaknesses)}${lines('강조할 장점과 근거', (ai.selling_points || []).map(x => `${x.point} (근거: ${x.evidence})`))}${lines('타깃 고객층', (ai.targets || []).map(t => `${t.segment}: ${t.reason}`))}${lines('사진으로 본 제품', ai.photo_review ? [...ai.photo_review.good, ...ai.photo_review.bad] : [])}
=== 판매 콘텐츠 초안 ===
${lines('상품명 후보', (c.product_names || []).map(x => x.name))}${lines('검색 키워드', c.keywords)}${lines('상세페이지 구성안', (c.detail_page || []).map(x => `${x.section}${x.title ? ` "${x.title}"` : ''}: ${x.content}`))}${lines('홍보 문구', (c.promo_copies || []).map(x => x.text))}
위 정보로 이 상품의 상세페이지 전체를 설계해 주세요. 판매 콘텐츠 초안의 좋은 문장은 살리고, 부족한 부분은 분석 결과로 채워 더 풍부하게 만듭니다.`;
  }

  function normalizeDetail(r, product) {
    const s = v => (typeof v === 'string' ? v.replace(/\s*[[(](일반|입력) ?정보[\])]/g, '').trim() : '');
    const arr = v => (Array.isArray(v) ? v : []);
    const seen = new Set();
    const sections = arr(r?.sections)
      .map(x => ({
        kind: DETAIL_KINDS.includes(x?.kind) ? x.kind : '',
        title: s(x?.title).slice(0, 40),
        lead: s(x?.lead),
        items: arr(x?.items).map(i => ({ title: s(i?.title).slice(0, 60), text: s(i?.text) })).filter(i => i.title || i.text).slice(0, 6),
      }))
      .filter(x => x.kind && !seen.has(x.kind) && seen.add(x.kind))
      .filter(x => x.kind === 'specs' || x.kind === 'closing' ? true : x.items.length);
    // 제품 정보 표는 AI가 빼먹어도 넣는다 (사용자가 입력한 사실만 들어가는 칸)
    if (!sections.some(x => x.kind === 'specs')) {
      const at = sections.findIndex(x => x.kind === 'faq' || x.kind === 'care' || x.kind === 'closing');
      sections.splice(at < 0 ? sections.length : at, 0, { kind: 'specs', title: '제품 정보', lead: '', items: [] });
    }
    const h = r?.hero || {};
    return {
      theme: DETAIL_THEMES.includes(r?.theme) ? r.theme : '',
      hero: {
        eyebrow: s(h.eyebrow).slice(0, 30),
        headline: s(h.headline) || product.name,
        subcopy: s(h.subcopy),
        badges: arr(h.badges).map(s).filter(Boolean).slice(0, 3),
      },
      sections,
    };
  }

  async function generateDetailPage(product, profit, ai, photoUrls, signal) {
    const p = getProvider();
    const images = [];
    if (p === 'cloud') {
      for (const url of (photoUrls || []).filter(Boolean).slice(0, 3)) {
        try { images.push(await smallPhoto(url, 768)); } catch { /* 못 읽은 사진은 빼고 보낸다 */ }
      }
    }
    const system = DETAIL_SYSTEM.replace('{{PHOTO}}', images.length ? ', 상품 사진' : '');
    const text = buildDetailText(product, profit, ai);
    const { parsed, model } = p === 'qwen' ? await requestQwen(system, text, DETAIL_SCHEMA, signal)
      : p === 'cloud' ? await requestCloud(system, text, DETAIL_SCHEMA, signal, images)
        : await requestClaude(system, text, DETAIL_SCHEMA, signal);
    const out = normalizeDetail(parsed, product);
    if (out.sections.filter(x => x.kind !== 'specs').length < 3) {
      throw new AIError('parse', 'AI가 상세페이지를 충분히 만들지 못했습니다. 다시 시도해 주세요.');
    }
    return { ...out, model };
  }

  /* ---------- 오타·맞춤법 검사 ---------- */
  // 사용자가 쓴 글에서 명백한 오타와 맞춤법만 찾는다. 문장을 다듬거나 내용을 바꾸지 않는다.
  const TYPO_SYSTEM = `당신은 한국어 맞춤법 검사기입니다. 온라인 판매자가 상품 등록 화면에 쓴 글에서 오타와 맞춤법 오류만 찾습니다.

지켜야 할 규칙:
- 명백한 오타(예: "원묵" → "원목"), 맞춤법(예: "되요" → "돼요", "왠만하면" → "웬만하면"), 꼭 필요한 띄어쓰기만 고칩니다.
- 문장을 더 좋게 다듬거나, 단어를 다른 말로 바꾸거나, 내용을 더하거나 빼지 마세요.
- 상품명·브랜드명·모델명·영어·숫자·단위·인증번호는 틀린 게 확실하지 않으면 그대로 둡니다.
- wrong에는 원문에 있는 글자를 한 글자도 바꾸지 말고 그대로 옮겨 씁니다. 고칠 부분이 들어간 짧은 구절(1~4어절)만 씁니다.
- right에는 wrong을 고친 글을, reason에는 왜 고치는지 한 문장으로 씁니다.
- field에는 그 글이 있는 칸의 이름(name, description, material, components, certName 중 하나)을 씁니다.
- 고칠 것이 없으면 items를 빈 배열로 둡니다. 확실하지 않으면 넣지 마세요.`;
  const TYPO_SCHEMA = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { field: { type: 'string' }, wrong: { type: 'string' }, right: { type: 'string' }, reason: { type: 'string' } },
          required: ['field', 'wrong', 'right', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
  const TYPO_LABELS = { name: '상품명', description: '상품 설명', material: '재질', components: '구성품', certName: '인증 이름' };

  // fields: { name, description, ... } → [{ field, label, wrong, right, reason }]
  // 상품명으로 대분류 추천: 그 판매처의 대분류 목록 안에서만 하나 고른다.
  const CAT_SYSTEM = `당신은 온라인 쇼핑몰의 상품 카테고리 분류 도우미입니다.
상품명을 보고, 주어진 대분류 목록 중 이 상품을 등록하기에 가장 알맞은 대분류 하나를 고릅니다.
- category에는 목록에 있는 이름을 글자 그대로 씁니다. 목록에 없는 이름을 만들지 마세요.
- 상품명만으로 무엇인지 알 수 없으면 category를 빈 문자열("")로 둡니다.`;
  async function suggestCategory(name, platformLabel, mains, signal) {
    if (!name || !mains?.length) return '';
    const p = getProvider();
    const request = p === 'qwen' ? requestQwen : p === 'cloud' ? requestCloud : requestClaude;
    const schema = { type: 'object', properties: { category: { type: 'string', enum: [...mains, ''] } }, required: ['category'], additionalProperties: false };
    const text = `판매처: ${platformLabel}\n상품명: ${name}\n\n대분류 목록:\n${mains.map(m => `- ${m}`).join('\n')}`;
    const { parsed } = await request(CAT_SYSTEM, text, schema, signal);
    const c = typeof parsed?.category === 'string' ? parsed.category.trim() : '';
    const flat = v => v.replace(/\s/g, '');
    return mains.includes(c) ? c : (c && mains.find(m => flat(m) === flat(c))) || '';
  }

  async function proofread(fields, signal) {
    const filled = Object.entries(fields).filter(([k, v]) => TYPO_LABELS[k] && v && v.trim());
    if (!filled.length) return [];
    const text = filled.map(([k, v]) => `[${k}] ${TYPO_LABELS[k]}\n${v}`).join('\n\n');
    const p = getProvider();
    const request = p === 'qwen' ? requestQwen : p === 'cloud' ? requestCloud : requestClaude;
    const { parsed } = await request(TYPO_SYSTEM, `아래 글의 오타와 맞춤법을 검사해 주세요.\n\n${text}`, TYPO_SCHEMA, signal);
    const s = v => (typeof v === 'string' ? v.trim() : '');
    const seen = new Set();
    // AI가 원문에 없는 글을 지어내거나, 고칠 게 없는데 넣은 항목은 버린다
    return (Array.isArray(parsed?.items) ? parsed.items : [])
      .map(x => ({ field: s(x?.field), wrong: s(x?.wrong), right: s(x?.right), reason: s(x?.reason) }))
      .map(x => (fields[x.field]?.includes(x.wrong) ? x : { ...x, field: filled.find(([, v]) => v.includes(x.wrong))?.[0] || '' }))
      .filter(x => x.field && x.wrong && x.right && x.wrong !== x.right && fields[x.field].includes(x.wrong))
      .filter(x => { const k = `${x.field}|${x.wrong}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(x => ({ ...x, label: TYPO_LABELS[x.field] }));
  }

  // 표시·광고 관련 규정에서 문제가 되기 쉬운 표현. 입력된 상품 정보에 있는 말은 제외한다.
  const RISKY_WORDS = ['최고', '최상', '1위', '최초', '유일', '완벽', '100%', '무해', '무독성', '부작용 없', '절대', '치료', '예방', '효능'];
  function normalizeContent(r, model, product) {
    const s = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const arr = v => (Array.isArray(v) ? v : []);
    const out = {
      product_names: arr(r?.product_names).map(x => ({ name: s(x?.name), reason: s(x?.reason) })).filter(x => x.name),
      keywords: arr(r?.keywords).map(s).map(k => k.replace(/^#/, '').trim()).filter(Boolean),
      detail_page: arr(r?.detail_page).map(x => ({ section: s(x?.section), title: s(x?.title).trim().slice(0, 40), content: s(x?.content), evidence: s(x?.evidence) || '확인 필요' })).filter(x => x.content),
      promo_copies: arr(r?.promo_copies).map(x => ({ channel: s(x?.channel), text: s(x?.text) })).filter(x => x.text),
      model,
      notices: [],
      createdAt: Date.now(),
    };
    const empty = Object.entries({ '상품명 후보': out.product_names, '검색 키워드': out.keywords, '상세페이지 구성안': out.detail_page, '홍보문구': out.promo_copies })
      .filter(([, v]) => !v.length).map(([k]) => `'${k}'`);
    if (empty.length) out.notices.push(`${empty.join(', ')}을(를) AI가 채우지 않았습니다. 다시 만들어 보세요.`);
    out.notices.push(...riskyWordNotices(out, product));
    return out;
  }
  function riskyWordNotices(out, product) {
    const source = [product.name, product.description, product.material, product.size, product.components, product.certification].join(' ');
    const texts = [...out.product_names.map(x => x.name), ...out.detail_page.map(x => x.title), ...out.detail_page.map(x => x.content), ...out.promo_copies.map(x => x.text)];
    const found = RISKY_WORDS.filter(w => !source.includes(w) && texts.some(t => t.includes(w)));
    return found.length
      ? [`과장되거나 광고 규정상 문제가 될 수 있는 표현이 들어 있습니다: ${found.map(w => `'${w}'`).join(', ')}. 사용 전에 수정해 주세요.`]
      : [];
  }

  class AIError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  // 사용자가 '취소하고 돌아가기'를 누른 경우
  const cancelled = () => new AIError('cancelled', '분석을 취소했습니다.');

  return { analyze, generateContent, generateDetailPage, proofread, suggestCategory, riskyWordNotices, getKey, setKey, isRemembered, getProvider, getQwenModel, setProvider, isReady, label, hasCloud, MODEL, QWEN_DEFAULT };
})();
