const LETTER_TO_PERCENT = {
  A: 95,
  'A-': 90,
  B: 85,
  'B-': 80,
  C: 75,
  'C-': 70,
  D: 65,
  F: 50
};

function gpaToPercent(value, scale) {
  const numeric = Number(value);
  const max = Number(scale || 4);
  if (Number.isNaN(numeric) || max <= 0) {
    throw new Error('Invalid GPA value');
  }
  return Math.round((numeric / max) * 100);
}

function toGpa4(percent) {
  if (percent >= 90) return 4.0;
  if (percent >= 85) return 3.7;
  if (percent >= 80) return 3.3;
  if (percent >= 75) return 3.0;
  if (percent >= 70) return 2.7;
  if (percent >= 65) return 2.3;
  if (percent >= 60) return 2.0;
  return 0;
}

function adaptGrade(input, rule = {}) {
  const type = String(input.originalType || '').toLowerCase();
  let percent;

  if (type === 'percent') {
    percent = Number(input.originalGrade);
  } else if (type === 'letter') {
    percent = LETTER_TO_PERCENT[String(input.originalGrade).trim().toUpperCase()];
  } else if (type === 'gpa') {
    percent = gpaToPercent(input.originalGrade, rule.gpaScale || input.gpaScale || 4);
  } else if (type === 'pass_fail') {
    percent = String(input.originalGrade).toLowerCase() === 'pass' ? 75 : 50;
  } else {
    throw new Error('Unsupported grade type');
  }

  if (typeof percent !== 'number' || Number.isNaN(percent) || percent < 0 || percent > 100) {
    throw new Error('Adapted grade is out of range');
  }

  const creditRatio = Number(rule.creditRatio || input.creditRatio || 1);
  return {
    adaptedScore: Math.round(percent),
    adaptedGpa: toGpa4(percent),
    adaptedCredit: Number((Number(input.originalCredit || 0) * creditRatio).toFixed(2)),
    passed: percent >= Number(rule.passScore || 60),
    ruleVersion: rule.version || 'default-v1'
  };
}

module.exports = { adaptGrade };
