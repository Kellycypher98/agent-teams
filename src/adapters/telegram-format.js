// Agents write Slack-style mrkdwn (*bold*, _italic_, `code`, <url|text>). Telegram wants HTML,
// and caps messages at 4096 characters, so convert and split here.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toTelegramHtml(input = '') {
  const keep = [];
  const stash = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(input);

  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => stash(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${esc(code)}</code>`));
  s = s.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, (_, url, label) => stash(`<a href="${esc(url)}">${esc(label)}</a>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => stash(`<a href="${esc(url)}">${esc(label)}</a>`));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => stash(esc(url)));
  s = s.replace(/<@[A-Z0-9]+>\s?/g, ''); // Slack user mentions mean nothing on Telegram

  s = esc(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');                                         // stray Markdown headers
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');                                       // **bold**
  // *bold*, _italic_, ~strike~: markers must hug the words (so "2 * 3 * 4" stays maths)
  const wrap = (ch, tag) => {
    const c = `\\${ch}`;
    s = s.replace(new RegExp(`(^|[\\s(>])${c}([^${c}\\s](?:[^${c}\\n]*?[^${c}\\s])?)${c}(?=[\\s).,!?:;<]|$)`, 'gm'), `$1<${tag}>$2</${tag}>`);
  };
  wrap('*', 'b');
  wrap('_', 'i');
  wrap('~', 's');
  s = s.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>').replace(/<\/blockquote>\n<blockquote>/g, '\n');
  s = s.replace(/^(\s*)[-•]\s+/gm, '$1• ');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

export const stripHtml = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Split raw (pre-conversion) text into chunks that stay under Telegram's limit after conversion. */
export function splitForTelegram(text, max = 3500) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  const blocks = text.split(/(\n\n)/);
  for (const part of blocks) {
    if ((cur + part).length > max && cur) { out.push(cur); cur = ''; }
    if (part.length > max) {
      for (const line of part.split('\n')) {
        if ((cur + line + '\n').length > max && cur) { out.push(cur); cur = ''; }
        cur += line.length > max ? line.slice(0, max) : `${line}\n`;
      }
    } else cur += part;
  }
  if (cur.trim()) out.push(cur);
  // keep ``` blocks balanced across chunks
  return out.map((c) => ((c.match(/```/g) || []).length % 2 ? `${c}\n\`\`\`` : c));
}
