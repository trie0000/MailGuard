import DOMPurify from 'dompurify';

const TAGS = ['a','b','i','em','strong','u','br','p','div','span','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','pre','code','table','thead','tbody','tr','th','td','img','hr','small','sub','sup'];
const ATTRS = ['href','title','alt','src','colspan','rowspan','style','width','height','align','border','cellpadding','cellspacing'];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script','iframe','object','embed','form','input','button','meta','link','style'],
  });
}

/** HTML → プレーン テキスト変換 (= AI に渡す用) */
export function htmlToText(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = sanitizeHtml(html);
  // <br>/<p> を改行に置換してから textContent
  tmp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  tmp.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,tr').forEach(b => {
    b.appendChild(document.createTextNode('\n'));
  });
  return (tmp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
