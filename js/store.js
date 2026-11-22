// 분석 결과를 이 브라우저(localStorage)에 저장한다.
const Store = (() => {
  const KEY = 'sellhelper.analyses';
  const SEQ_KEY = 'sellhelper.seq'; // 지금까지 붙인 가장 큰 번호 (삭제해도 번호를 다시 쓰지 않는다)

  // 분석마다 바뀌지 않는 번호(no)를 붙인다. 번호가 없는 예전 분석은 분석한 시간 순서대로 붙인다.
  function readSeq() { try { return Number(localStorage.getItem(SEQ_KEY)) || 0; } catch { return 0; } }
  function number(list) {
    let seq = Math.max(readSeq(), ...list.map(r => r.no || 0));
    const missing = list.filter(r => !r.no).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    missing.forEach(r => { r.no = ++seq; });
    try { localStorage.setItem(SEQ_KEY, String(seq)); } catch { /* 저장소를 못 쓰면 번호만 화면용으로 쓴다 */ }
    return missing.length > 0;
  }
  function all() {
    let list;
    try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
    if (number(list)) write(list);
    return list;
  }
  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch {
      return false; // 저장 공간 부족 또는 저장소 사용 불가
    }
  }
  function get(id) { return all().find(r => r.id === id) || null; }
  function save(record) {
    const list = all().filter(r => r.id !== record.id);
    if (!record.no) number([...list, record]); // 새 분석은 다음 번호
    list.unshift(record);
    return write(list);
  }
  function remove(id) { return removeMany([id]); }
  function removeMany(ids) {
    const drop = new Set(ids);
    return write(all().filter(r => !drop.has(r.id)));
  }
  function clear() { return write([]); }

  return { all, get, save, remove, removeMany, clear };
})();
