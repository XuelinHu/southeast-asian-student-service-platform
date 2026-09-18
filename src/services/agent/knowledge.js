// ---------------------------------------------------------------------------
// 面向本平台业务的静态知识库。
// 智能体不做微调，业务口径靠这份知识 + 实时查库工具共同支撑：
//   - 知识库回答"规则是怎么定的""某个状态是什么意思""这系统怎么用"
//   - 工具回答"现在库里实际有多少、具体是哪些人"
// 未登录游客只能检索这里，不挂任何查库工具。
// ---------------------------------------------------------------------------

const ENTRIES = [
  {
    id: 'platform-overview',
    title: '平台定位与模块全景',
    keywords: ['平台', '系统', '介绍', '什么系统', '功能', '模块', '能做什么', '留学生', '东南亚'],
    content: [
      '本系统是面向国际留学生（以东南亚生源为主）的信息管理平台 V1.0，覆盖从入学到毕业的全周期管理。',
      '共 13 个业务模块：用户管理、学生管理、教师管理、班级管理、国籍管理、住宿管理、签证管理、学习情况、成绩记录、成绩规则、对接学校、登录日志、问答记录。',
      '角色分三类：管理员（admin）可管理全部数据；教师（teacher）可查看学生、班级、成绩与学习情况；学生（student）只能看本人档案与本人成绩。',
      '所有列表均支持分页查询、关键字搜索、排序与条件筛选，管理台按菜单组织，每个菜单都是分页的。'
    ].join('\n')
  },
  {
    id: 'grade-adaptation',
    title: '成绩适配规则',
    keywords: ['成绩', '适配', '换算', 'gpa', '绩点', '分数', '百分制', '等级制', '学分', '归一化', '转换', '成绩单'],
    content: [
      '成绩适配解决的是"不同国家、不同学校、不同计分方式没法直接比较"的问题：把境外原始成绩统一折算成本校口径的百分制成绩与 GPA。',
      '',
      '一条成绩记录（grade_records）包含三组字段：',
      '  · 原始侧：original_grade（原始成绩）、original_type（原始计分方式）、original_credit（原始学分）、source_school_id / source_country_code（来源学校与国别）',
      '  · 适配侧：adapted_score（折算后的百分制分数）、adapted_gpa（折算后的绩点）、adapted_credit（折算后的学分）、passed（是否通过）',
      '  · 过程侧：rule_version（用哪一版规则算的）、adapt_status（适配状态）、exception_reason（异常原因）、audit_status（审核状态）、audited_by / audited_at（谁在什么时候审的）',
      '',
      '原始计分方式（original_type）支持四种：percent（百分制）、letter（等级制，如 A/B+/C）、gpa（GPA）、pass_fail（通过制）。',
      '适配依据是成绩规则表（grade_rules），每个"学校 + 国家"可以有一条规则，字段包括：',
      '  · gpa_scale：该校的 GPA 满分制（4.0 / 4.3 / 5.0 等），决定 GPA 折算分母',
      '  · credit_ratio：学分折算比例，境外学分 × 该比例 = 本校学分',
      '  · pass_score：及格线，adapted_score 低于它就判 passed = 否',
      '  · version：规则版本号，会写回成绩记录的 rule_version，保证历史成绩可追溯当时用的是哪版规则',
      '  · status / effective_from / effective_to：规则自身的启用状态与生效区间',
      '',
      '为什么会有"异常"：原始成绩缺失、等级制出现规则表里没定义的等级、来源学校没有配置规则、折算后分数超出合理区间等，都会把 adapt_status 置为 exception，并把原因写进 exception_reason。',
      '异常记录不会被自动修正，需要教务人工核对后走审核流程（audit_status：pending 待处理 / approved 已通过 / rejected 已驳回 / archived 已归档）。'
    ].join('\n')
  },
  {
    id: 'visa',
    title: '签证与居留管理',
    keywords: ['签证', '居留', 'visa', '护照', '到期', '续签', '过期', '临期', '出入境'],
    content: [
      '签证模块（visas）管理留学生的签证与居留许可，关键字段：visa_type（签证类型）、visa_no（签证号）、issue_date（签发日期）、expiry_date（到期日期）、residence_permit_no（居留许可号）、status（状态）。',
      '状态取值：valid 有效、expiring 临期、expired 过期、renewing 续签中。',
      '',
      '预警口径：到期日在"今天起 60 天内"的签证计为临期预警，这是系统默认的提醒窗口。',
      '为什么重要：留学生签证一旦过期属于非法居留，会直接影响学籍，所以系统把签证到期放在首页预警的第一位，并接入风险清单。',
      '续签建议：临期预警出现后就应启动续签（status 置为 renewing），并把新的 expiry_date 回填，避免状态与日期不一致。'
    ].join('\n')
  },
  {
    id: 'dormitory',
    title: '住宿管理',
    keywords: ['住宿', '宿舍', '床位', '房间', '楼栋', '入住', '退宿', 'dormitory'],
    content: [
      '住宿模块（dormitories）按"楼栋 - 房间 - 床位"三级记录床位分配，字段：building（楼栋）、room_no（房间号）、bed_no（床位号）、student_id（入住学生）、check_in_date（入住日期）、check_out_date（退宿日期）、status（床位状态）。',
      '床位状态：available 空闲、occupied 在用、reserved 预留、maintenance 维修。',
      '',
      '异常口径：床位处于 maintenance（维修）或 reserved（预留）却仍挂着学生，或者 check_out_date 已经早于今天但记录未清理，都会进风险清单。',
      '一名学生同时只应占用一个在用床位；发现重复占用需要人工核对后调整。'
    ].join('\n')
  },
  {
    id: 'study-warning',
    title: '学习预警',
    keywords: ['学习', '预警', '考勤', '出勤', '作业', '课堂', '表现', '警告', 'attendance'],
    content: [
      '学习情况模块（study_records）按"学生 + 课程 + 记录时间"逐次记录学习表现，字段：course_code / course_name（课程）、attendance_rate（出勤率，百分比）、homework_status（作业情况）、class_performance（课堂表现）、warning_level（预警级别）、teacher_id（记录教师）、recorded_at（记录时间）。',
      '预警级别：none 无、notice 提示、warning 预警、serious 严重。',
      '',
      '预警口径：warning_level 为 warning 或 serious，或者 attendance_rate 低于 70%，都计入学习风险。',
      '处理建议：warning 级别先由任课教师谈话提醒并记录；serious 级别需要通知班主任与教务，必要时联系家长。多次预警应合并看同一名学生的趋势，而不是逐条处理。'
    ].join('\n')
  },
  {
    id: 'roles-permission',
    title: '角色与权限边界',
    keywords: ['权限', '角色', '管理员', '教师', '学生', '能看', '越权', '登录', '账号'],
    content: [
      '系统有三种角色，权限逐级收窄：',
      '  · 管理员 admin：管理全部业务数据，含用户管理、重置密码、启停账号、审核成绩。',
      '  · 教师 teacher：查看学生、班级、成绩、学习情况与风险清单，可录入学习记录与发起成绩适配，但不能管理用户。',
      '  · 学生 student：只能查看本人档案与本人成绩，看不到其他任何学生的数据。',
      '',
      '注册：任何人都可以自助注册，注册出来的账号角色固定为"学生"，且立即生效可直接登录，不需要审核。',
      '注册时填写学号会同时建立学生档案；不填学号则只创建登录账号，之后再补档案。',
      '改密：登录后可在"账号安全"里修改密码，改完其他设备上的登录会立即失效。忘记密码不提供自助找回，需要管理员在管理台重置。'
    ].join('\n')
  },
  {
    id: 'risk-list',
    title: '风险清单与首页预警',
    keywords: ['风险', '预警', '告警', '首页', '看板', '概览', '统计', '提醒'],
    content: [
      '风险清单把五类问题汇总成一张表，每条都带风险类型、学生学号与姓名、风险日期、说明：',
      '  1. visa_expiring 签证临期 —— 60 天内到期',
      '  2. grade_exception 成绩异常 —— adapt_status 为 exception',
      '  3. low_score 低分 —— 适配后分数低于 60',
      '  4. learning_warning 学习预警 —— warning_level 为 warning/serious，或出勤率低于 70%',
      '  5. dormitory_exception 住宿异常 —— 床位维修/预留却挂着学生，或退宿日期已过',
      '',
      '首页概览展示四项核心数字：学生人数、教师人数、签证预警数、成绩异常数。风险清单在管理台和教师门户都能看到。'
    ].join('\n')
  },
  {
    id: 'how-to-use',
    title: '系统使用指引',
    keywords: ['怎么用', '使用', '操作', '教程', '管理台', '菜单', '分页', '搜索', '导出', '修改密码', '注册'],
    content: [
      '登录：学生、教师、管理员共用同一个入口，登录后按角色看到不同的页签。',
      '注册：在登录页切到"注册账号"，填写账号、姓名、密码即可。填学号会同时建立学生档案。',
      '修改密码：登录后进入"账号安全"，需要先验证当前密码。改密成功会换发新令牌，其他设备上的登录立即失效。',
      '',
      '管理台（管理员与教师可见）：左侧按模块列出全部菜单，每个菜单都支持：',
      '  · 分页：底部可切换页码与每页条数',
      '  · 搜索：按该模块的可搜索字段做关键字匹配',
      '  · 筛选：按状态、角色等条件过滤',
      '  · 排序：点击表头按该列升序/降序',
      '  · 新增 / 编辑 / 删除：编辑用抽屉表单，删除前会二次确认',
      '',
      '学生门户：可以查看个人中心（学号、国籍、班级、护照、联系方式等档案信息）和我的成绩（原始成绩、适配成绩、适配 GPA、审核状态）。'
    ].join('\n')
  },
  {
    id: 'agent-self',
    title: '本智能体的能力与边界',
    keywords: ['智能体', '助手', '你', '你是谁', '能回答', '语音', '模型', 'ollama', '本地'],
    content: [
      '本智能体是本平台内置的业务助手，直接接在本机 Ollama 上运行的国内开源模型（默认 qwen3:14b），也支持切换到云端模型。',
      '它不依赖专门训练：业务口径来自内置知识库，实时数字来自对数据库的只读查询工具，两者结合来回答。',
      '',
      '能做：解释业务规则与状态口径、查询库内真实统计数据、按条件筛选学生与风险清单、说明系统怎么操作。',
      '不能做：修改任何数据（只有只读查询工具）、查询其他学生的隐私数据（学生角色被强制限制在本人）、回答与平台业务无关的问题。',
      '',
      '语音：系统是纯网页应用，语音对话直接用浏览器自带的语音识别与语音合成，不需要安装任何客户端；需要 https 或 localhost 访问，否则浏览器不开放麦克风。',
      '如果回答里没有把握，它会明确说不确定，而不是编造数字。所有涉及数量的回答都应当来自工具查询结果。'
    ].join('\n')
  },
  {
    id: 'faq',
    title: '常见问题',
    keywords: ['为什么', '怎么办', '常见问题', 'faq', '错误', '失败', '异常'],
    content: [
      '问：为什么签证预警是 0？\n答：预警窗口是"今天起 60 天内到期"。如果数据是较早导入的，签证到期日可能都已经过去，需要先把签证数据刷新到当前日期。',
      '问：为什么学生注册后提示找不到档案？\n答：注册时没有填学号，只会创建登录账号。填学号会同时建立学生档案。',
      '问：为什么成绩显示异常？\n答：来源学校没有配置成绩规则、等级制出现未定义的等级、原始成绩缺失等都会导致适配异常，需要教务核对后审核。',
      '问：为什么模型回答得很慢？\n答：首次使用某个模型需要把它加载进显存，冷启动可能要一分钟左右；加载完成后同样的问题几秒就能回答。问答界面提供"加载模型"按钮可以提前预热。',
      '问：学生能看到别的学生吗？\n答：不能。学生角色的查询在服务端被强制限制为本人，即使通过接口直接请求也会被拒绝。'
    ].join('\n')
  }
];

// ---------------------------------------------------------------------------
// 检索：中英文都按子串匹配。中文没有空格分词，且业务问法集中，
// 用关键词命中的条数打分比引入分词器更简单可靠。
// ---------------------------------------------------------------------------

function search(query, limit = 3) {
  const text = String(query || '').toLowerCase().trim();
  if (!text) return [];

  const scored = ENTRIES.map((entry) => {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (text.includes(keyword.toLowerCase())) score += 3;
    }
    // 标题整串命中权重更高，例如直接问"成绩适配规则"
    if (text.includes(entry.title.toLowerCase())) score += 6;
    // 正文里出现问句中的词也加分，但权重低，避免长篇条目压过精准命中
    for (const word of text.split(/[\s,，。？?！!、；;]+/).filter((w) => w.length >= 2)) {
      if (entry.content.toLowerCase().includes(word)) score += 1;
    }
    return { entry, score };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((item) => item.entry);
}

function listTopics() {
  return ENTRIES.map((entry) => ({ id: entry.id, title: entry.title }));
}

function getById(id) {
  return ENTRIES.find((entry) => entry.id === id) || null;
}

/** 把命中条目拼成给模型看的参考资料。 */
function format(entries) {
  if (!entries.length) return '';
  return entries.map((entry) => `【${entry.title}】\n${entry.content}`).join('\n\n');
}

module.exports = { ENTRIES, search, listTopics, getById, format };
