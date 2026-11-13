// 수익성 계산과 종합 평가 규칙. AI 없이도 동작하는 순수 계산 함수만 둔다.
const Profit = (() => {
  // 판매가 1개 기준 순이익. 수수료는 판매가에 비례한다.
  function calc(input, price = input.price) {
    const fee = price * input.feeRate / 100;
    const totalCost = input.cost + input.shipping + input.packaging + fee;
    const profit = price - totalCost;
    const margin = price > 0 ? profit / price * 100 : 0;
    return { price, fee, totalCost, profit, margin };
  }

  // 목표 마진율을 맞추는 판매가: price = 고정비 / (1 - 수수료율 - 목표마진율)
  function priceForMargin(input, marginPct) {
    const fixed = input.cost + input.shipping + input.packaging;
    const denom = 1 - input.feeRate / 100 - marginPct / 100;
    if (denom <= 0) return null;
    return Math.ceil(fixed / denom / 100) * 100; // 100원 단위 올림
  }

  // 손익분기 판매가 (순이익 0)
  function breakEven(input) {
    const denom = 1 - input.feeRate / 100;
    if (denom <= 0) return null;
    return Math.ceil((input.cost + input.shipping + input.packaging) / denom);
  }

  // 판매가 변경에 따른 비교표: 현재가 ±10%, ±20%, 목표 마진 권장가
  function scenarios(input) {
    const rows = [-20, -10, 0, 10, 20].map(pct => ({
      label: pct === 0 ? '현재 판매가' : `${pct > 0 ? '+' : ''}${pct}%`,
      kind: pct === 0 ? 'current' : '',
      ...calc(input, Math.round(input.price * (1 + pct / 100) / 100) * 100 || input.price),
    }));
    const rec = priceForMargin(input, input.targetMargin);
    if (rec && Math.abs(rec - input.price) >= 1) {
      rows.push({ label: `목표 마진 ${input.targetMargin}% 권장가`, kind: 'recommend', ...calc(input, rec) });
    }
    return rows.sort((a, b) => a.price - b.price);
  }

  // 수익성 점수: 마진율 0% → 20점, 40% 이상 → 100점 (선형). 적자는 20점 아래로.
  function score(margin) {
    const s = margin < 0 ? 20 + margin : 20 + margin * 2;
    return Math.round(Math.max(0, Math.min(100, s)));
  }

  function scoreReason(margin) {
    if (margin < 0) return '현재 가격으로는 1개 팔 때마다 손해가 납니다.';
    if (margin < 10) return '마진율이 10% 미만으로 비용 변동에 매우 취약합니다.';
    if (margin < 20) return '마진율이 낮은 편이라 광고비·반품 비용을 감당하기 어렵습니다.';
    if (margin < 30) return '보통 수준의 마진율입니다.';
    return '마진율이 충분해 가격 경쟁이나 프로모션 여력이 있습니다.';
  }

  // 종합 판정. 위험도는 높을수록 나쁘므로 (100 - 위험도)로 반영한다.
  function verdict(scores, margin) {
    const total = Math.round((scores.market + scores.compete + scores.profit + scores.diff + (100 - scores.risk)) / 5);
    const reasons = [];
    let level;
    if (margin <= 0) {
      level = 'bad';
      reasons.push('현재 판매가로는 순이익이 0원 이하입니다. 가격이나 비용 구조를 먼저 조정해야 합니다.');
    } else if (total < 50 || scores.risk >= 75) {
      level = 'bad';
      if (total < 50) reasons.push(`종합 점수가 ${total}점으로 50점 미만입니다.`);
      if (scores.risk >= 75) reasons.push(`판매 위험도가 ${scores.risk}점으로 높습니다.`);
    } else if (total >= 70 && scores.risk < 60 && margin >= 15) {
      level = 'good';
      reasons.push(`종합 점수가 ${total}점이고 위험도(${scores.risk}점)가 관리 가능한 수준입니다.`);
    } else {
      level = 'warn';
      if (total < 70) reasons.push(`종합 점수가 ${total}점으로 판매 추천 기준(70점)에 못 미칩니다.`);
      if (scores.risk >= 60) reasons.push(`판매 위험도가 ${scores.risk}점으로 보완이 필요합니다.`);
      if (margin < 15) reasons.push(`마진율이 ${margin.toFixed(1)}%로 15% 미만입니다.`);
    }
    const label = { good: '판매 추천', warn: '추가 검토', bad: '판매 비추천' }[level];
    return { total, level, label, reasons };
  }

  // 사용자가 입력한 경쟁상품 가격만으로 계산한 가격 위치
  function competitorStats(input) {
    const priced = (input.competitors || []).filter(c => c.price > 0);
    if (!priced.length) return null;
    const prices = priced.map(c => c.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const cheaper = prices.filter(p => p < input.price).length;
    return {
      count: priced.length,
      avg,
      min: Math.min(...prices),
      max: Math.max(...prices),
      diffPct: (input.price - avg) / avg * 100,
      cheaper, // 내 상품보다 싼 경쟁상품 수
      atAvg: calc(input, Math.round(avg)),
    };
  }

  return { calc, priceForMargin, breakEven, scenarios, score, scoreReason, verdict, competitorStats };
})();
