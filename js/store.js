// 분석 결과를 이 브라우저(localStorage)에 저장한다.
const Store = (() => {
  const KEY = 'sellhelper.analyses';

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
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
