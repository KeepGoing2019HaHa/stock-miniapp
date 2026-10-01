const { formatTime, validDate } = require('./model');

const WINDOWS = [
  { key: 'all', label: '累计' },
  { key: 'last_20_sessions', label: '近 20 交易日' },
  { key: 'last_60_sessions', label: '近 60 交易日' }
];
const STATUS = {
  pending: '待收盘核验', awaiting_reflection: '已评分 · 待复盘',
  reviewed: '已复盘', late: '迟到 · 不计分', excluded: '价格口径变化 · 不计分'
};
const LESSON_STATUS = { candidate: '待验证', supported: '有一定支持', retired: '已停用', expired: '已过期' };
const ROLES = { market: '技术分析', news: '新闻事件', social: '市场情绪', fundamentals: '基本面', decision: '综合判断' };
const validTicker = (value) => /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z])?$/.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const price = (value) => value === null ? '—' : `$${value.toFixed(2)}`;
const assert = (condition) => {
  if (!condition) throw new Error('每日复盘响应不完整，请刷新重试。');
};

function validateDashboard(data, ticker) {
  assert(data && data.ticker === ticker && typeof data.tracked === 'boolean' && formatTime(data.generated_at));
  assert(data.summary && data.history && data.lessons);
  WINDOWS.forEach(({ key }) => {
    const summary = data.summary[key];
    assert(summary && ['scored', 'predictions', 'pending', 'late', 'excluded', 'awaiting_reflection'].every(
      (field) => Number.isInteger(summary[field]) && summary[field] >= 0
    ));
    ['direction_hit', 'absolute_error', 'absolute_percentage_error', 'interval_hit',
      'interval_width', 'brier', 'naive_absolute_error'].forEach((field) => {
      assert(summary.scored === 0 ? summary[field] === null : finite(summary[field]) && summary[field] >= 0);
    });
    assert(Array.isArray(summary.signatures));
    ['direction_hit', 'interval_hit', 'brier'].forEach((field) => {
      assert(summary[field] === null || summary[field] <= 1);
    });
  });
  assert(Array.isArray(data.history.items) && data.history.items.length <= 5);
  assert(data.history.next_before === null || validDate(data.history.next_before));
  data.history.items.forEach((item) => {
    assert(item && Number.isInteger(item.id) && validDate(item.day) && STATUS[item.status]);
    assert(formatTime(item.created_at) && finite(item.reference_close) && item.reference_close > 0);
    const forecast = item.forecast;
    assert(forecast && ['close', 'low', 'high'].every((key) => finite(forecast[key]) && forecast[key] > 0));
    assert(forecast.low <= forecast.close && forecast.close <= forecast.high);
    assert(finite(forecast.up_probability) && forecast.up_probability >= 0 && forecast.up_probability <= 1);
    assert(typeof forecast.rationale === 'string' && typeof forecast.risks === 'string');
    assert(item.actual_close === null || finite(item.actual_close) && item.actual_close > 0);
    assert(item.reflection === null || typeof item.reflection === 'string');
    if (item.scores !== null) {
      assert(item.scores && typeof item.scores.direction_hit === 'boolean' &&
        typeof item.scores.interval_hit === 'boolean' && finite(item.scores.absolute_error));
    }
    if (item.candidate !== null) {
      assert(item.candidate && typeof item.candidate.condition === 'string' && typeof item.candidate.advice === 'string');
    }
  });
  assert(Array.isArray(data.lessons.items) && data.lessons.items.length <= 10);
  assert(data.lessons.next_before === null || Number.isInteger(data.lessons.next_before) && data.lessons.next_before > 0);
  data.lessons.items.forEach((item) => {
    assert(item && Number.isInteger(item.id) && LESSON_STATUS[item.status] && ROLES[item.role]);
    assert(typeof item.condition === 'string' && typeof item.advice === 'string' && validDate(item.source_day));
    assert(['supports', 'contradicts'].every((key) => Number.isInteger(item[key]) && item[key] >= 0));
  });
  return data;
}

function metrics(summary, window) {
  const item = summary[window];
  return {
    counts: item,
    metrics: [
      { label: '方向命中率', value: percent(item.direction_hit), hint: '收盘涨跌，相对前一日收盘' },
      { label: '平均价格误差', value: price(item.absolute_error), hint: `相对误差 ${percent(item.absolute_percentage_error)}` },
      { label: '80% 区间覆盖率', value: percent(item.interval_hit), hint: `平均区间宽度 ${price(item.interval_width)}` },
      { label: '上涨概率评分', value: item.brier === null ? '—' : item.brier.toFixed(3), hint: 'Brier 分数，越低越好' }
    ],
    baseline: price(item.naive_absolute_error),
    mixedVersions: item.signatures.length > 1
  };
}

function displayHistory(items) {
  return items.map((item) => ({
    id: item.id, day: item.day, status: item.status, statusLabel: STATUS[item.status], open: false,
    predicted: price(item.forecast.close), actual: price(item.actual_close),
    reference: price(item.reference_close), referenceDate: item.reference_date,
    interval: `${price(item.forecast.low)} – ${price(item.forecast.high)}`,
    upProbability: percent(item.forecast.up_probability),
    direction: item.forecast.close > item.reference_close ? '预测上涨' : '预测不涨',
    directionResult: item.scores === null ? '未计分' : item.scores.direction_hit ? '方向命中' : '方向未命中',
    error: item.scores === null ? '—' : price(item.scores.absolute_error),
    intervalResult: item.scores === null ? '未计分' : item.scores.interval_hit ? '落入预测区间' : '超出预测区间',
    createdLabel: formatTime(item.created_at), dataLabel: formatTime(item.data_as_of),
    rationale: item.forecast.rationale, risks: item.forecast.risks, reflection: item.reflection,
    lessonCondition: item.candidate ? item.candidate.condition : '',
    lessonAdvice: item.candidate ? item.candidate.advice : ''
  }));
}

function displayLessons(items) {
  return items.map((item) => ({
    id: item.id, status: item.status, statusLabel: LESSON_STATUS[item.status], roleLabel: ROLES[item.role],
    condition: item.condition, advice: item.advice, sourceDay: item.source_day,
    supports: item.supports, contradicts: item.contradicts,
    availableLabel: formatTime(item.available_at), testedLabel: formatTime(item.last_tested) || '尚无后续验证'
  }));
}

module.exports = { WINDOWS, validTicker, validateDashboard, metrics, displayHistory, displayLessons };
