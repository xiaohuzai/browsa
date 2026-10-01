# Dashboard 字段地图

官方文档核对日期：2026-10-01。此表记录官方字段模型，不声称查看过用户账号的实时后台。用户当前标签、控件上限与可选项优先；历史填写包只作内容基线。

## 页面 → 字段 → 来源

| 页面 / 位置 | 字段或控件 | 来源与填写方式 |
|---|---|---|
| 软件包 / Package | ZIP、版本、名称、简短说明 | 上传包提供；名称与简短说明不能在 Dashboard 直接编辑，i18n 值来自包内 locale |
| 商品详情 / Store listing | Detailed description | 每语完整文字，直接粘贴 |
| 商品详情 | Category | 实际下拉选项；不假定存在主/次两级 |
| 商品详情 | Language / locale dropdown | 选择包内 `_locales` 支持的语言，切换该语说明及素材 |
| 图片资源 | Store icon、Screenshots、Promo video、Small promo tile、Marquee promo tile | 图片上传或 YouTube URL，图块不能本地化 |
| 图片资源（语言覆盖） | Localized screenshots、Localized promo video | 该语截图/YouTube URL，可保留默认资源 |
| 其他字段 | Official URL、Homepage URL、Support URL、Mature content | 已验证网址选择、URL 文字、内容分级选项 |
| 隐私权 / Privacy practices | Single purpose description | 单一用途完整文字 |
| 隐私权 | Permissions justification | 每个实际权限/主机权限框一段理由 |
| 隐私权 | Remote code | 远程代码选择及实际出现的理由框 |
| 隐私权 | Data usage | 用户数据类型勾选及多项有限用途认证 |
| 隐私权 | Privacy policy URL | 实际可访问的政策 URL |
| 测试说明 / Test instructions（可能译为访问权限） | 给审核员的说明与凭据 | 可选、非公开；说明框与账号/密码框分别处理 |
| 分发 / Distribution | Visibility、Regions | 实际选择值；付费/免费项只在后台出现时列 |

**What's new 不在上述官方字段中。** Listing 文档的 changelog 是详细说明中的可选内容，不是独立表单或自动触达老用户的功能。不能生成“在商品详情找到 What's new”之类步骤。

## 隐私问卷的字段模型

数据类型的常见原名如下；生成时以后台实际文字为准：

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- Web history
- User activity
- Website content

用途认证通常分别涉及：不向第三方出售/转移数据（获准情况除外）、不用于与单一用途无关的目的、不用于信用评估/借贷。这些是各自的认证复选框，不能压缩成一条“遵守政策：勾”。仅在事实满足时选择，实际原文需核对。

官方 FAQ 定义“处理”为收集、传输、使用或共享，并明确举例网页截取/截图、URL、HTTP 内容、cookies。**仅本地处理或存储也需披露**。browsa 需要逐项核对网页附加内容、URL、聊天与文件、本地 Key、站点 cookies、用户指定端点；功能数据流和开发者遥测是不同事实，不据“无 analytics”推导全部不勾选。

## 来源

- [Prepare your extension — manifest 元数据不能在 Dashboard 编辑](https://developer.chrome.com/docs/webstore/prepare?hl=en#manifest)
- [Complete your listing — 详细说明、分类、语言、链接与本地化素材](https://developer.chrome.com/docs/webstore/cws-dashboard-listing?hl=en)
- [Supply images — 尺寸、格式及资源要求](https://developer.chrome.com/docs/webstore/images?hl=en)：新上传前核验；文档有历史版本，不猜当前控件限制。
- [Fill out the privacy fields — 单一用途、权限、远程代码、数据类型与认证](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy?hl=en)
- [User Data FAQ — 本地处理也需披露](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq?hl=en)
- [Provide test instructions — 可选、非公开](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions?hl=en)
- [Set up distribution — 可见性与地区](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution?hl=en)
