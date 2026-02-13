export function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
export function commaTC(n){
  const x = Number(n || 0);
  return x.toLocaleString("en-US") + " TC";
}
