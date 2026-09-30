const STATUS = {
  queued: '排队中',
  running: '研究中',
  succeeded: '已完成',
  failed: '未完成'
};
const RATINGS = {
  Buy: '买入观点',
  Overweight: '增持观点',
  Hold: '持有观点',
  Underweight: '减持观点',
  Sell: '卖出观点',
  REVIEW: '需人工复核'
};
const REPORTS = [
  ['market', '市场与技术'],
  ['sentiment', '市场情绪'],
  ['news', '新闻与事件'],
  ['fundamentals', '基本面'],
  ['investment_plan', '投资研究计划'],
  ['trader_plan', '交易研究计划']
];

function isActive(job) {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

function formatTime(value) {
  if (!value) return '';
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function displayJob(job) {
  return Object.assign({}, job, {
    statusLabel: STATUS[job.status] || '未知状态',
    statusClass: Object.prototype.hasOwnProperty.call(STATUS, job.status) ? job.status : 'unknown',
    createdLabel: formatTime(job.created_at)
  });
}

function displaySummary(job) {
  const summary = displayJob(job);
  delete summary.result;
  return summary;
}

function reportSections(result) {
  const reports = (result && result.reports) || {};
  return REPORTS.map(([key, title]) => ({
    key,
    title,
    body: typeof reports[key] === 'string' ? reports[key] : '',
    open: false
  })).filter((section) => section.body);
}

function ratingLabel(rating) {
  return RATINGS[rating] || '需人工复核';
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateForm(ticker, analysisDate, maximumDate) {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(ticker)) {
    return '请输入股票代码，例如 NVDA、0700.HK、600519.SS。';
  }
  if (!validDate(analysisDate)) return '请选择有效的分析日期。';
  if (!validDate(maximumDate)) return '尚未取得服务端可用日期，请刷新后再试。';
  if (analysisDate > maximumDate) return `分析日期不能晚于 ${maximumDate}。`;
  return '';
}

function isDefiniteRejection(error) {
  return error && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 425 && error.status !== 429;
}

function uuidFromBytes(bytes) {
  if (bytes.length !== 16) throw new Error('随机数据长度不正确');
  const data = Array.from(bytes);
  data[6] = (data[6] & 15) | 64;
  data[8] = (data[8] & 63) | 128;
  const hex = data.map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

module.exports = {
  isActive, displayJob, displaySummary, reportSections, ratingLabel, validDate,
  validateForm, isDefiniteRejection, uuidFromBytes, formatTime
};
