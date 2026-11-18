import type { MessageEnvelope } from '../shared/types.js';

// Only an unambiguous instruction at the end of the sender's own message can
// bypass inference. Everything outside this narrow grammar stays with the model.
export function requestedSilence(batch: MessageEnvelope[]): 'wait' | 'end' | undefined {
  const last = batch.at(-1);
  if (
    !last ||
    last.trigger === 'ambient' ||
    last.directedElsewhere ||
    (last.replyTo && last.quoted?.actorId !== 'bot') ||
    batch.some((m) => m.actorId !== last.actorId)
  )
    return;
  const previous = batch.at(-2)?.text.trim();
  if (
    previous &&
    /[：:“「『]$|(?:原话(?:是)?|他(?:们)?说|她(?:们)?说|这样说|这么说)[，,。\s]*$/u.test(previous)
  )
    return;
  const text = last.text.trim();
  if (/["'“”‘’「」『』《》：:？?]/u.test(text)) return;
  const parts = text
    .replace(/[。.!！\s]+$/u, '')
    .split(/[,，。！!；;\n]+/u)
    .map((part) => part.trim());
  const tail = parts.pop();
  const wait =
    /^(?:(?:请|你)?先?(?:等一下|等一等|等等)|等我(?:把话)?说完(?:再回(?:复)?)?|我(?:还没|还没有)说完|(?:你)?先别回(?:复)?)(?:呢|啊|呀|哈)?$/u;
  const end =
    /^(?:这一?(?:条(?:消息)?|句(?:话)?)(?:你)?|你)?(?:不用|不必|无需)(?:再)?(?:回(?:复)?(?:我|这条(?:消息)?)?|回答我)(?:了|啦|哈|哦)?$/u;
  const action = tail && (wait.test(tail) ? 'wait' : end.test(tail) ? 'end' : undefined);
  if (!action) return;
  // A short first-person update can precede the request, as can another pause.
  // A reporting verb, quotation, condition or negation can change who is speaking.
  if (
    parts.some(
      (part) =>
        !wait.test(part) &&
        (!/^我(?:刚差点|(?:先|准备|打算|得|要)去|先(?:写|忙|走|休息|下线)|去睡)/u.test(part) ||
          /说|问|讲|提到|转述|转发|听见|看到|告诉|意思|写道|写着|以为|如果|假如|比如|举例|并非|不是|不要|不让|没让|没叫|喊|要求|提醒/u.test(
            part,
          )),
    )
  )
    return;
  return action;
}
