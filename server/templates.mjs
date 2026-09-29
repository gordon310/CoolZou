export const templates = {
  fresh: { name: '清新自然', description: '留白充足，适合活动记录', page: 'FFFFFF', accent: '26735B', muted: '65716C', soft: 'F1F7F3', divider: 'DCE8E1' },
  playful: { name: '活力童趣', description: '色彩明快，适合孩子分享', page: 'FFFCFA', accent: 'D96765', muted: '786A67', soft: 'FFF1ED', divider: 'F0DCD6' },
  report: { name: '简洁汇报', description: '结构清楚，适合课堂展示', page: 'FFFFFF', accent: '416273', muted: '66747A', soft: 'F0F4F6', divider: 'D7E2E7' }
};

export const templateKeys = Object.keys(templates);
export const normalizeTemplate = value => templateKeys.includes(value) ? value : 'fresh';
