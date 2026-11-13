const { formatTime, validDate } = require('./model');

const STATUSES = {
  waiting_data: '等待样本', running: '评估中', promoted: '已晋级',
  rejected: '未晋级', unchanged: '无变更', failed: '任务失败', diagnostic: '仅开发回测',
  retry_wait: '等待重试', superseded: '旧规则已停用'
};
const CHECKS = {
  direction_first_improved: '方向优先，持平时 MAE 更低',
  mae_improved_1pct: 'MAE 改善超过 1%', direction_not_worse: '方向准确率不退化',
  brier_not_worse: '概率误差不退化', interval_score_not_worse: '区间评分不退化',
  paired_gain_positive: '配对改善下界为正', fresh_holdout: '未使用的独立测试集',
  complete_history: '完整全历史回测'
};
const numeric = (value, percent = false) => Number.isFinite(value) ?
  (percent ? (value * 100).toFixed(1) + '%' : value.toFixed(3)) : '--';

function comparisonRows(backtest) {
  return backtest ? [
    ['方向准确率', 'direction_accuracy', true], ['MAE / USD', 'mae'],
    ['Brier', 'brier'], ['区间评分', 'interval_score']
  ].map(([label, key, percent]) => ({ label,
    current: numeric(backtest.current && backtest.current[key], percent),
    candidate: numeric(backtest.candidate && backtest.candidate[key], percent)
  })) : [];
}

function display(response) {
  if (!response || response.ticker !== 'MSFT' || !response.summary || !response.history ||
      !Array.isArray(response.history.items) ||
      !['samples', 'labelled', 'fresh'].every((key) => Number.isInteger(response.summary[key]) && response.summary[key] >= 0) ||
      (response.history.next_before !== null && !validDate(response.history.next_before))) {
    throw new Error('进化数据不完整，请重试。');
  }
  const items = response.history.items.map((item) => {
    if (!validDate(item.day) || !STATUSES[item.status]) throw new Error('进化记录格式异常。');
    const backtest = item.backtest;
    const comparisons = comparisonRows(backtest);
    const previous = item.previous_strategy || {};
    const strategy = item.strategy || {};
    return Object.assign({}, item, {
      statusLabel: STATUSES[item.status], completedLabel: formatTime(item.completed_at || item.started_at),
      nextRetryLabel: item.next_retry_at ? formatTime(item.next_retry_at) : '',
      comparisons, open: false,
      oldModels: [previous.quick_model, previous.deep_model].filter(Boolean).join(' / '),
      newModels: [strategy.quick_model, strategy.deep_model].filter(Boolean).join(' / '),
      oldTools: (previous.tools || []).join(', '), newTools: (strategy.tools || []).join(', '),
      candidates: (item.candidates || []).map((candidate) => Object.assign({}, candidate, {
        statusLabel: ({ pending: '待评估', better: '优于正式版', rejected: '未改善',
          failed: '分析失败', running: '评估中', retry_wait: '等待重试' })[candidate.status] || candidate.status,
        comparisons: comparisonRows(candidate.backtest),
        models: [candidate.strategy && candidate.strategy.quick_model,
          candidate.strategy && candidate.strategy.deep_model].filter(Boolean).join(' / '),
        tools: (candidate.strategy && candidate.strategy.tools || []).join(', '),
        best: item.best_candidate === candidate.number,
        nextRetryLabel: candidate.next_retry_at ? formatTime(candidate.next_retry_at) : ''
      })),
      checks: backtest ? Object.keys(CHECKS)
        .filter((key) => Object.prototype.hasOwnProperty.call(backtest.checks || {}, key))
        .map((key) => ({ key, label: CHECKS[key], passed: backtest.checks[key] === true })) : [],
      sampleResults: (item.sample_results || []).map((sample, index) => ({
        key: index, day: sample.day, repeat: sample.repeat + 1,
        current: numeric(sample.current_error), candidate: numeric(sample.candidate_error)
      }))
    });
  });
  return { summary: response.summary, champion: response.champion, items,
    next: response.history.next_before, updated: formatTime(response.generated_at) };
}

module.exports = { display };