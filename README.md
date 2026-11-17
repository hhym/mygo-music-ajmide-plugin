# 阿基米德 FM / Ajmide —— MyGo Music 音源插件

上海广播电视台（SMG）旗下「阿基米德」（ajmide.com）的 mygo-music 插件。匿名可用，不需要登录。

## 安装

```
mygo-music://install-plugin?repo=hhym/mygo-music-ajmide-plugin
```

或者把 `mygo-music-ajmide-plugin.zip` 解压到 mygo 的插件目录。

## 能播什么

| 内容 | 来源 | 格式 |
| --- | --- | --- |
| 音频单集（phId） | `short-audio-qn.ajmide.com/image/…` | m4a（`audio/mp4`，`ftypM4A`，支持 Range/206） |
| 电台（brand）里的节目卡片 | 同上 | m4a |
| 电台直播 | `rscdn.ajmide.com/…m3u8` | HLS，**播不了** |

直播这一条是硬限制：mygo 播放器只认 `mp3/flac/ogg/wav/m4a/aac`，全仓库没有 m3u8 支持；阿基米德的直播只有 HLS（`rscdn-bk.ajmide.com/r_84/nglive_84.m3u8?sign=…`），没有 mp3 直链。所以电台详情里，直播节目只作为条目出现，点播放会提示「只有 HLS 直播流」。

## 接口地图

所有 JSON 都在 `a.ajmide.com`，前面挂阿里云 WAF。**没有签名、没有 token**，一个移动 UA 加一个 `Referer: https://m.ajmide.com/` 就够了。

坑在于**路径是带版本目录的，而各接口的版本号互相对不上**——同一套服务里，电台列表在 `v28`，音频详情在 `v17`，相关音频在 `v14`，节目音乐在 `v10`，当前直播节目在 `v27`。所以每个请求的版本号都写死在代码里，不要统一改。

| 用途 | 路径 | 参数 |
| --- | --- | --- |
| 全国电台列表 | `/v28/get_radio_station_all.php` | 无 |
| 单个电台详情 | `/v28/get_radio_station.php` | `brandId` |
| 电台周节目单 | `/v28/get_program_list_by_week.php` | `brandId` |
| 当前直播节目 | `/v27/getBrandPlayList.php` | `brandId` |
| 音频详情 | `/v17/get_audio_detail.php` | `phId`（不带时返回推荐块 `recommendAudios`） |
| 相关音频 | `/v14/getRelateAudioList.php` | `phId` |
| 节目音乐 | `/v10/get_program_music.php` | 参数不透明，代码里当候选试 |
| 音频库 | `/v17/get_audio_library.php` | 同上 |

`get_audio_detail.php` 不带参数时，`data.recommendAudios.list` 就是首页推荐声音，插件首页的第一栏就取它。

### 第二个坑：WAF 405 与封 IP

`a.ajmide.com` 前面的阿里云 WAF（错误页 `data-spm=a3c0e`）**对短时间重复请求会直接回 HTTP 405**，挤得狠一点会把出口 IP 整个封掉一段时间——被封之后连「刚才还能用」的路径也一律 405，甚至直接拒连（curl 000）。

所以代码里：

- 每次网关调用之间强制间隔 **2.5 秒**（`MIN_GAP`），并且串行，不并发；
- 一次失败会等 1.5 秒重试一次；
- 遇到 405 抛的是 `阿基米德网关限流（405），稍后再试`，不会再往上撞。

反复刷新首页/快速连点电台，是这个插件最容易把自己刷进黑名单的地方。

### 第三个坑：没有全站搜索

`searchAudio.php`、`searchProgram.php`、`get_search_home.php`、`get_suggest_list.php` 在 `v1`～`v45` 全部是 `File not found`（dex 里只有名字，线上没部署）。

所以插件里的搜索只有两条路：

1. 输入电台名（「北京」「交通」「音乐」）→ 在电台列表里做本地匹配；
2. 输入纯数字（≥5 位）→ 当作 `brandId` 直接打开那个电台。

首页推荐是服务端给的（`get_audio_detail.php` 无参），不是关键词搜索。

## 内部 id 约定

| 前缀 | 含义 | 打开方式 |
| --- | --- | --- |
| `p:<phId>` | 音频单集 | 播放（`stream`），也当「单集专辑」打开 |
| `pr:<programId>` | 节目 | 依次试 `get_program_music` / 周节目单 / 相关音频，取第一个出卡片的 |
| `b:<brandId>` | 电台 | 周节目单 + 当前直播节目，合并成曲目列表 |

`b:` 页里的曲目来自两处：`get_program_list_by_week.php?brandId=` 的音频卡片（有 `phId`，能播），以及 `getBrandPlayList.php?brandId=` 的当前直播节目（没 `phId`，只有 m3u8，标成不可播）。

## 结构容错

阿基米德不同版本接口的字段名不统一（`imgPath` / `img_path`、`phId` / `phid`、`subject` / `name`），而且没有公开文档。代码里用 `deepCards()` 递归遍历响应，把所有「带 phId 且带标题」的对象当成音频卡片捞出来——这样即使周节目单的包装层变了，列表也不会整片空掉。

## 目录

```
plugin.json        插件清单（id: ajmide，v1.0.0，minAppVersion 0.1.20）
index.js           全部导出
locales/zh-CN.json 中文文案
```

## 已知限制

- 电台直播不可播（只有 HLS），这是插件层面解决不了的。
- 没有关键词搜索，只能按电台名 / brandId 找。
- 网关限流很敏感：2.5 秒一次的串行请求是踩过坑后的值，别调低。
- 「节目」页（`pr:`）依赖三个候选接口，线上未逐一验证到底哪个出数据，靠 `deepCards()` 兜底；如果某节目打开是空的，直接开它下面的单集（`p:`）最稳。
- 开发时用的出口 IP 曾被 WAF 拉黑，`get_program_list_by_week.php` 的真实返回结构没能在生产环境亲眼确认，只确认了它的 URL 与参数（H5 电台页确实这么调）。
