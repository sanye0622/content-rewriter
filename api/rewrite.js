// Vercel Edge Function：映射到 /api/rewrite
// 作用：接收前端传来的（用户自带的）DeepSeek Key + 原稿，转发给 DeepSeek，流式返回。
// 注意：这里只做转发，绝不保存/记录用户的 Key 或内容。

const PLATFORM_GUIDE = {
  '公众号': '段落清晰、可加小标题；开头一句抓住注意力，结尾有收束；适度口语但不轻浮。',
  '小红书': '短句为主、节奏轻快；可适度用 emoji 和分点；亲切有种草感；结尾可给 3-5 个话题标签。',
  '知乎':   '逻辑清晰、有论据支撑；理性克制，可结合个人经验；避免营销腔和浮夸。',
  '微博':   '短而精炼、有记忆点；一两句话讲清核心；可带一个钩子。',
  '通用':   '通顺自然、表达清楚，不绑定特定平台风格。'
};

function buildSystem(platform, tone){
  const guide = PLATFORM_GUIDE[platform] || PLATFORM_GUIDE['通用'];
  return `你是一个中文内容改写助手。用户会给你一段【他自己原创的草稿】，你的任务是把它重写、润色、并适配到指定平台。

请在内部按这三步工作，只输出第三步的最终成稿，不要输出过程说明：
1. 判断原稿的体裁、核心信息和结构。
2. 按【目标平台：${platform}】的风格重写。该平台要点：${guide}
3. 通读检查通顺度和逻辑，修掉病句和啰嗦，输出干净的成稿。

硬性要求：
- 语气：${tone}。
- 必须忠实保留原稿的事实、观点和核心意思，不得编造原稿没有的信息或数据。
- 这是用户自己的内容，目标是写得更好、更适配平台，不是伪装成别人的或规避检测。
- 直接输出成稿正文，不要加"以下是改写结果"之类的开场白。`;
}

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { key, src, platform, tone, model } = body || {};
  if (!key || !src) {
    return new Response(JSON.stringify({ error: '缺少 Key 或原稿' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let upstream;
  try {
    upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        stream: true,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: buildSystem(platform, tone) },
          { role: 'user', content: '【我的原稿】\n' + src }
        ]
      })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '无法连接 DeepSeek：' + (e && e.message || e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // DeepSeek 报错（如 Key 无效 401、余额不足 402、限流 429）时，原样把状态码和原因带回前端
  if (!upstream.ok) {
    let detail = '';
    try {
      const errText = await upstream.text();
      try { const ej = JSON.parse(errText); detail = (ej.error && ej.error.message) || errText; }
      catch (_) { detail = errText; }
    } catch (_) { }
    return new Response(JSON.stringify({ error: 'DeepSeek 返回错误', detail: detail.slice(0, 300) }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 成功：把 DeepSeek 的 SSE 流原样透传给前端
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
