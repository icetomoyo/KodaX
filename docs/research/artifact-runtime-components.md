# 能否用公开组件独立实现统一的 Artifact SDK 与运行时？

结论：可以独立实现统一的创作、导入、编辑、渲染、导出接口及依赖交付；现成组件足够组成第一版，但 Office 完整往返保真、动画和 Excel 计算兼容不能直接承诺。以下为公开文档调研与设计判断，没有安装组件、运行评测，也没有读取专有 Artifact Tool 实现。[Office 兼容边界](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html)

核对日期：2026-10-12。网页中的 stable/latest 和 GitHub master 会变动；正式选型须锁定发行版本，不能把分支文档当作已交付版本。

## 已核对的公开能力

| 场景 | 可用组件与真实能力 | 必须保留的边界 |
| --- | --- | --- |
| 新建 PPTX | PptxGenJS 支持文本、表格、形状、图片、图表、母版及 PPTX 导出；可运行于 Node/浏览器。[官网](https://gitbrent.github.io/PptxGenJS/) | 本次核对标注 4.0.1 的公开类型只有创作/导出入口，没有已有 PPTX 的读取/导入接口；不能把它独自包装成完整导入编辑器。这是公开 API 核对结论。[类型定义](https://github.com/gitbrent/PptxGenJS/blob/master/types/index.d.ts#L12-L137) |
| PPTX 导入/编辑 | python-pptx 提供创建、读取、更新 PPTX；可操作文字、图片、表格、常见图表，不要求安装 PowerPoint。[功能](https://python-pptx.readthedocs.io/en/latest/index.html#feature-support) | 项目声明可保留不理解的既有内容，但也声明功能未覆盖全部格式；“可往返保存”与“可理解、编辑、渲染全部元素”不同。[已有文件](https://python-pptx.readthedocs.io/en/latest/user/presentations.html#opening-a-presentation) |
| PPTX 浏览器渲染 | ZCode 的预览引擎直接解析实际 PPTX ZIP，通过 `@aiden0z/pptx-renderer/browser` 构建并渲染幻灯片；本机安装包的第三方清单包含该库 1.2.4。[源码](C:/Works/PubProj/ZCode/packages/ui/src/presentation/pptxRendererPreviewEngine.ts:1)、[安装包清单](C:/Users/ADMIN/AppData/Local/Programs/ZCode/resources/THIRD-PARTY-NOTICES.md:33) | 这条 UI 预览路径不调用 LibreOffice；界面 PDF 导出打印渲染后的 DOM，区别于 PPT skill 的 LibreOffice→PDF→PNG 路线。界面可预览不证明 agent 已获得图片；复杂对象保真及独立 SDK 接入仍待验证。[UI 导出](C:/Works/PubProj/ZCode/packages/ui/src/components/ui/pptx-preview-viewer.tsx:731)、[技能路线](C:/Works/PubProj/ZCode/apps/zcode-cli/packages/presentations-plugin/skills/pptx/SKILL.md:162) |
| XLSX 结构操作 | openpyxl 支持新建、加载、修改、保存工作簿；ExcelJS 可读写 XLSX 数据和样式，提供 Node 路径。[openpyxl](https://openpyxl.readthedocs.io/en/stable/tutorial.html#loading-from-a-file)、[ExcelJS](https://github.com/exceljs/exceljs#file-io) | openpyxl 明确警告已有 shapes 可能在读取再保存时丢失；copy_worksheet 不复制图片/图表；不能默认覆盖原件。[警告](https://openpyxl.readthedocs.io/en/stable/tutorial.html#loading-from-a-file)、[复制限制](https://openpyxl.readthedocs.io/en/stable/tutorial.html#create-a-workbook) |
| XLSX 公式 | openpyxl 和 ExcelJS 可以保存公式及缓存值。[openpyxl](https://openpyxl.readthedocs.io/en/stable/tutorial.html#loading-from-a-file)、[ExcelJS](https://github.com/exceljs/exceljs#formula-value) | 两者均不计算公式；缓存可能是上次 Excel 打开的值，不能作为当前计算结果。[openpyxl 明确说明](https://openpyxl.readthedocs.io/en/stable/simple_formulae.html#using-formulae)、[ExcelJS 明确说明](https://github.com/exceljs/exceljs#formula-value) |
| XLSX 专门创作 | XlsxWriter 可写工作簿，并允许指定公式结果缓存。[FAQ](https://xlsxwriter.readthedocs.io/faq.html) | 不读取或修改已有文件；默认公式缓存为 0，不能仅凭打开/截图判定公式已重算。[FAQ](https://xlsxwriter.readthedocs.io/faq.html#q-why-do-my-formulas-show-a-zero-result-in-some-non-excel-applications) |
| Office 渲染/转换 | LibreOffice 支持 headless、按格式过滤器转换、指定输出目录；Windows 文档推荐命令行使用 soffice.com。[命令行](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) | 官方列出 PPTX 的间距、母版、分组/媒体，以及 XLSX 的图表、条件格式、函数等兼容差异；不能当作微软 Office 等价实现。[兼容边界](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html) |
| Office 可编程模型 | UNO 的 XComponentLoader 加载/新建文档；XStorable 保存/导出；XCalculatable.calculateAll 重算所有单元格。[加载](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XComponentLoader.html)、[存储](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XStorable.html)、[重算](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1sheet_1_1XCalculatable.html) | storeAsURL 不能用于仅导出过滤器，应使用 storeToURL；calculateAll 是 Calc 计算，仍需保留 Excel 兼容边界。[存储语义](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XStorable.html)、[计算差异](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html) |
| PDF 创作/局部编辑 | pdf-lib 可创建/加载 PDF、画文字/图形/图片、操作页面与表单，纯 JS。[官网](https://pdf-lib.js.org/) | 不能提取普通页面文本；“修改 PDF”主要是页面/绘制/表单操作，不能宣称通用语义编辑。[限制](https://github.com/Hopding/pdf-lib#limitations) |
| PDF 渲染 | PDF.js 加载实际 PDF、按页取得 viewport、渲染到 canvas；可放入浏览器运行时。[官方示例](https://mozilla.github.io/pdf.js/examples/#rendering-the-page) | 同一个 canvas 的渲染需等上一页完成；PDF 图片证据是渲染结果，不是内容编辑模型。[官方示例](https://mozilla.github.io/pdf.js/examples/) |
| HTML 交互与输出 | Playwright 可执行定位/点击、捕获页面/元素截图，并打印页面 PDF。[点击](https://playwright.dev/docs/api/class-locator#locator-click)、[截图](https://playwright.dev/docs/screenshots)、[PDF](https://playwright.dev/docs/api/class-page#page-pdf) | PDF 默认使用 print CSS 且调整打印颜色；屏幕截图、打印 PDF、交互状态应分别验收。[PDF 语义](https://playwright.dev/docs/api/class-page#page-pdf) |
| 图片与 GIF | sharp 可创建/读取/变换图片，支持 animated GIF/WebP 输入与动画输出示例。[构造与动画](https://sharp.pixelplumbing.com/api-constructor/) | 平台二进制及 optional dependencies 影响能否运行；整幅动画与逐帧位置/时间检查应分开。[安装](https://sharp.pixelplumbing.com/install/)、[元数据](https://sharp.pixelplumbing.com/api-input/) |
| 视频/动画解码 | FFmpeg 可选择时间/场景帧，ffprobe 可输出帧、流、时间等机器可读信息。[select](https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect)、[ffprobe](https://ffmpeg.org/ffprobe.html#Main-options) | 抽帧覆盖仅证明选定位置；完整流检查、时间连续性、字幕/音视频同步需另有验收范围，不能从少数静帧推断全部通过。（设计判断，依据输出能力） |
| 视频结构辅助 | FFmpeg 提供黑段、冻结、静音检测并输出时间信息。[blackdetect](https://ffmpeg.org/ffmpeg-filters.html#blackdetect_002c-blackdetect_005fvulkan)、[freezedetect](https://ffmpeg.org/ffmpeg-filters.html#freezedetect)、[silencedetect](https://ffmpeg.org/ffmpeg-filters.html#silencedetect) | 这些是阈值检测，不能自动认定创作错误；刻意静止/黑场/静音需模型结合目标判断。（设计判断，依据过滤器定义） |

## 依赖与交付约束

- PPTX/XLSX 公开格式可依据 ECMA-376 独立设计，规范明确词汇、文档表示、打包和生产者/消费者要求；本调研没有借用专有 SDK 代码或接口细节。[ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- PptxGenJS、python-pptx、openpyxl、ExcelJS、pdf-lib 是 MIT 系列许可；再分发要保留对应版权/许可，具体发行包及传递依赖仍需核对。[PptxGenJS](https://github.com/gitbrent/PptxGenJS/blob/master/LICENSE)、[python-pptx](https://github.com/scanny/python-pptx/blob/master/LICENSE)、[openpyxl](https://openpyxl.readthedocs.io/en/stable/)、[ExcelJS](https://github.com/exceljs/exceljs/blob/master/LICENSE)、[pdf-lib](https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md)
- Playwright、PDF.js、sharp 分别采用 Apache 2.0；sharp 底层 libvips 是 LGPL-2.1-or-later，不能只看 JS 包许可。[Playwright](https://github.com/microsoft/playwright/blob/main/LICENSE)、[PDF.js](https://github.com/mozilla/pdf.js/blob/master/LICENSE)、[sharp](https://github.com/lovell/sharp/blob/main/LICENSE)、[libvips](https://www.libvips.org/)
- LibreOffice 使用 MPL 2.0，并包含因版本而不同的其他开源许可组件；官方要求参考发行安装包内的 LICENSE。运行时交付必须保留实际构建的许可信息。[官方许可](https://www.libreoffice.org/licenses/)
- FFmpeg 默认 LGPL 2.1+，启用 GPL 部件会改变整份 FFmpeg 的许可；二进制构建选项、外部编码器、对应源码决定具体交付义务，不能只写“FFmpeg 开源”。[官方许可说明](https://ffmpeg.org/legal.html#License)
- Playwright 版本与浏览器二进制配对，需要安装匹配浏览器及系统依赖；支持独立缓存路径/封闭安装。因此仅 npm 包并不等于准备好了浏览器运行时。[官方运行时交付](https://playwright.dev/docs/browsers#managing-browser-binaries)
- sharp 官方提供多个 OS/CPU 预编译包，并警告跨平台 lockfile/optional dependencies 与 bundler 外部化问题；独立运行时应验证目标平台，而非复用开发机目录。[官方安装约束](https://sharp.pixelplumbing.com/install/)
- LibreOffice profile 需要写权限并可指定独立 UserInstallation；据此建议每个受管作业使用独立 profile/输出目录，隔离现有用户 Office 会话。（设计判断）[参数与 profile](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

## 设计判断（不是已实现能力）

- 应独立拥有 **Artifact SDK + 配套可选运行时**：统一的是创作、导入、内容编辑、版式辅助、交付和证据体验，不是把若干转换命令改名。
- SDK 的最小操作面可为 `create/open/inspect/edit/render/export`；对象身份和产物版本稳定，agent 发现问题后能定位页/对象/单元格并修改。
- PPTX 形状/文本、XLSX 单元格/公式、HTML DOM/交互、视频时间线采用各自内容模型；统一产物身份、内容操作和结果数据，Session/Run 生命周期沿用 KodaX 的单一 owner。
- 新建文件可由受控内容模型导出；已有复杂文件的导入返回可编辑范围、保留/降级/拒绝情况，不能把可打开视为可完整编辑。[导入风险依据](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html)
- 新建 PPT/XLSX 优先通过 JS 内容操作复用 PptxGenJS/ExcelJS；已有 PPTX 的编辑通过明确支持的格式层进行，保留未修改原件，不从 renderer 的 JSON 摘要重建全部原文件。公式重算按声明能力执行并产生新版本，缓存值不能证明已重算。[组件边界](https://python-pptx.readthedocs.io/en/latest/user/presentations.html)、[计算边界](https://github.com/exceljs/exceljs#formula-value)
- PPTX 静态渲染优先接 `pptx-renderer` + 受管浏览器。以 ZCode 的 1.2.4 为对照，1.3.0 为首版候选并锁版本；两版已通过常见页面独立探针，但不支持完整编辑/写回，不能忽略静默省略对象。SDK 补支持诊断、字体/图片加载和布局稳定检测。[源码审查与探针](pptx-renderer-audit.md)
- 浏览器可以复用兼容宿主能力或按需准备 headless Chromium；库本身小不等于裸机无需浏览器。LibreOffice 仅按已识别的格式转换、真实文档分页、表格重算或受支持对象补充需要提供；静态 LibreOffice 渲染不能补 PPT 动画播放，也不自动认证原生 Office 兼容。[浏览器边界](pptx-renderer-audit.md)、[LibreOffice 边界](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html)
- `render` 应渲染 **实际导出的交付物**；HTML 预览可作为版式辅助，但不能代替最终 PPTX/PDF/XLSX 渲染验收。
- 回执绑定交付物哈希/版本、渲染器版本、页/区域/交互状态/时间点、字体或兼容警告；修改后旧图不能作为新版本的通过证据。
- 运行时负责版本锁定、依赖准备与自检；SDK 报告真实支持范围，模型看图和修复仍由正常 agent 完成，组件退出成功不等于视觉审查通过。
- KodaX 通过 Host-managed extension 接入，复用 registerTool/registerCapabilityProvider/registerSkillPath/getExecutionScope，核心包不直接依赖 Office/浏览器/视频大组件。[现有接缝](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/extensions/types.ts:425)
- ExtensionExecutionScope 已有 Session/Run/Invocation、AbortSignal 与受检 invokeTool，但没有通用固定 argv/browser runner；注册工具不会自动将 SDK 内部 spawn/FS/network 纳入 OS sandbox。SDK 的执行依赖由调用方注入，KodaX adapter 首先补窄的受管固定操作 runner，复用既有授权、sandbox、owned-process 与清理结算。[scope](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/extensions/execution-contract.ts:7)、[受检调用](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/agent-runtime/tool-dispatch.ts:314)、[现有受管 spawn](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/tools/bash.ts:744)
- Client 外部调用通过 runs.startTool 进入 Host 普通工具 gate，暂不新增 Client 业务域；执行保障是需要实装验证的 adapter/runner 责任。Actor 的预算 admission 不代表默认存在全局物理请求/token 硬上限，必须验证真实预算和 Provider 并发接线。[Client seam](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/client-contract.ts:175)、[Actor admission](C:/Works/GitProj/KodaX-AI/KodaX/packages/agent/src/actors/controller.ts:976)
- 单一会话 owner、DTO 边界及传输语义继续由 KodaX Runtime 负责；不可为了 Artifact 再引入 verifier sidecar 或第二个会话 owner。[现有架构](C:/Works/GitProj/KodaX-AI/KodaX/docs/HLD.md:435)
- 现有 agent media 是输入附件原语，不能把它扩展成文档创作模型；SDK 产出的图片证据通过已有媒体/图片工具输入。[现有边界](C:/Works/GitProj/KodaX-AI/KodaX/docs/DD.md:1201)
- 跨平台执行适配器采用明确 executable + argv，所有外部能力受 Host gate 管理；取消、文件所有权、并发隔离作为交付自检的一部分，避免依赖 bash 或绕过 sandbox。（设计要求）

### 2026-10-12 收口：所有视觉评审走同一操作与证据面

| 视觉要求 | 优先路径 | 能力不足时 |
| --- | --- | --- |
| 静态：图片、SVG、海报、图表、地图、示意图 | 解码最终图片或在受管浏览器渲染实际源；透明背景/细节范围明确 | 按实际格式补图像/矢量组件；无法获得像素则未验证 |
| 分页：PPT、PDF、Word、表格、报告 | PPTX 轻量 renderer；PDF 逐页渲染；文档/表格明确页或 sheet/range，数据与公式另查 | 根据具体缺口选择 LibreOffice/计算组件；无法支持的对象或分页报告未验证 |
| 交互：HTML、应用、移动/桌面/终端 UI、canvas、3D | 操作实际目标表面，结合截图与 DOM/状态/事件，记录 viewport/state/camera | 需要对应浏览器/设备/桌面/终端 capture adapter；静态截图不能补交互，缺适配器就未验证 |
| 时序：视频、GIF、网页动画、PPT 转场 | 最终媒体解码、连续帧/时间戳或实际播放检查；声音/同步按要求另查 | 按需 FFmpeg 或实际播放器；PPT 动画要求真实兼容播放能力，两种静态 PPT renderer 均不能证明通过 |

- 自动选择依据用户要求和实际支持诊断；后端选择及切换原因返回。被阻网络、缺字体/资源、未知对象不会因改用后端变成通过；后端未支持的要求仍为未验证。
- 依赖准备是正常权限下的安装/自检动作，按需下载固定版本并保留许可信息；不得为了评审自动提权、启动第二个 owner 或直接从 extension 旁路 spawn。
- 首版独立 SDK 管理文件内容与稳定定位；KodaX Host adapter 注册声明副作用的窄工具，Client 经 `runs.startTool`/普通 agent 工具执行。图片通过现有 tool-result/media 通道进入模型，既有 Client observe/history 保存与读取结果；不另增通用 operation journal、重放机制或 verifier 数据库。
- 修复是对当前版本的内容操作；导出真实文件后复查变更及共享样式、分页、资产的影响。证据包含 source/evidence hash、engine/version、页/区域/state/camera/time、资源诊断；功能事实与像素须对应同一版本/状态。主 Agent 持有任务与修复，指定的终审者按要求逐项报告 passed/issues/unverified；结束、取消、预算耗尽或总体 pass 不覆盖未观察范围。
- 同一 Host 管理的同目标写入/修复/交互取证串行，其他独立产物可并行；expected hash 必须在提交临界区重查，单有哈希不是锁。首版保留冻结输入、独占创建新输出；当前 trustedTextMutationHost 是 string 协议，原位二进制覆盖另需受管 staged-file commit。外部编辑不遵守内部锁仍须报告冲突/过期。[文本提交边界](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/types.ts:1789)
- 复用浏览器指经过自检的可执行文件或受管能力，启动独立 profile/context，不接管用户既有标签。BrowserContext 不等于 OS 权限隔离；权限边界不同的 Run 需要分别受管进程。LibreOffice profile、输出和下载/解包目录有明确 owner；AbortSignal、根进程退出或 context.close 不证明所有子进程清理完成，unknown 保留。[现有结算](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/tools/bash.ts:768)

### 2026-10-12 三方交叉质询后的评审政策与实施顺序

- 架构、依赖交付、评审三个子 Agent 分别核对源码，再互相质询及反驳；以下是设计判断，不是新功能已经实施。
- 终审者按用户独立验收要求、参考忠实度、不确定诊断及真实取证需要选择；不新增简单/复杂阈值、全局强制 reviewer 开关或多页必派规则。用户明确要求独立验收时必须满足；无法满足就保留未验证，其他任务可明确采用自查。
- 静态 reviewer 使用 fresh context 读取原始 brief、参考、当前冻结图片和内容/功能事实，不带作者通过叙事；验证 reviewer 自身的图像能力与实际图片输入。Fresh context 减少诱导，不证明统计独立或必然更可靠。[既有评审指令](C:/Works/GitProj/KodaX-AI/KodaX/packages/agent/src/capabilities/skills/builtin/visual-review/SKILL.md:60)
- 独立交互 tester 使用限定目标/动作的窄工具权限，可以授权点击、播放、截图或切换镜头，但不能编辑产物或任意 shell。它不是 `readOnly:true` reviewer；现有只读子 Agent 排除非 readonly 扩展工具，不修改该安全语义。[实际限制](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/child-executor.ts:469)
- 主 Agent 创作时可局部看图调试，每项要求只有一个最终评审责任者；有证据矛盾时局部重新取证并纠正，既不盲从误报破坏正确内容，也不无证据覆盖意见或反复派人直到 pass。
- 首个切片依次实现受管 runner/快照/依赖自检、有限 PPT 创作与导入编辑、新路径导出、轻量渲染、真实看图与修复复查；编辑范围逐对象验收，不由渲染支持推导编辑支持。未知部件/关系应保留，母版/分组修改仍需验证影响；不能保证用户要求的保真时拒绝相关修改而保留原件。
- 随后交付图片/PDF、浏览器交互、视频时序、LibreOffice 分页/重算/转换及外部表面 adapter。四类证据接口先确定，各后端逐项验收；首版以本地 Host 为基线，远程可用须另声明 remoteContract，不能把本地路径/context 当作远程能力。[远程声明](C:/Works/GitProj/KodaX-AI/KodaX/packages/coding/src/tools/types.ts:72)
- 实施验收包含真实子进程取消与清理、不同权限/同目标并发、Windows 中文与空格路径/无 POSIX shell 假设、缺资源/未知对象/陈旧截图、只读 judge 与受限 tester、裸机/离线依赖交付；先做确定性代码/集成验证，模型行为实验遵守现有 eval 成本与并发规则。

## 未证实

- 任意复杂 PPTX/XLSX 的无损导入、完整语义编辑与导出往返；上述组件官方文档没有提供这样的整体承诺。
- LibreOffice 或自建渲染在所有字体、动画、媒体、图表、公式上与 Microsoft Office 一致；官方文档反而列出差异。[兼容边界](https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html)
- 自建 SDK 与 Artifact Tool 的性能、保真度或开发成本相当；没有读取专有实现，也没有进行对比评测。
- 各运行时组件统一打包后的 Windows/macOS/Linux 体积、安装可靠性、完整第三方授权清单；须针对实际锁定构建核验。

## 未解问题

- 第一版支持哪些可编辑对象及公式类别，哪些复杂元素保留、降级或拒绝，需形成可执行的能力清单。
- 首版运行时离线包、各 OS 依赖准备仍需验证。2026-10-12 已实现 FEATURE_301 的独立可选 SDK/Host adapter 与 PPT 闭环；Windows 打包独立安装、实际轻量渲染、真实模型修复复查与能力缺失负例通过，范围见 [验证记录](../test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md)。
- 默认 Office 渲染结果按哪个兼容目标验收，以及需要原生 Office 复核的场景如何表示，需要明确产品承诺。
