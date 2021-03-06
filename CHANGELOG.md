# 更新日志

## 0.3.39 - 2020-11-02

### Fix

- 无障碍规范检查的问题修复，并增加一些新的规则

## 0.3.37 - 2020-10-30

### Improve

- 增加无障碍规范检查
- 增加新版本表达式的支持

## 0.3.36 - 2020-09-29

### Improve

- 优化输入 `${` 自动插入 `}` 字符的体验，现在输入 `}` 后不会多一个 `}` 字符了
- 增加在非 type 类型 Action 中使用 if 等属性的错误检查
- Node 增加 `position`, `center`, `convertPoint()` 等定义
- 增加 `tint-color`, `numberValue()`, `env` 等定义

## 0.3.35 - 2020-08-28

### Fix

- 修复未打开文件夹的情况会抛异常导致部分功能不可用

### Improve

- 增加 Controller, on-scroll, lerp 等定义

## 0.3.33 - 2020-08-26

### Improve

- 设置了 scale-aspect-fill 但未设置 clip 属性时报警告，避免出现内容超出的 Bug
- 增加 View 的函数定义

## 0.3.32 - 2020-08-11

### Fixed

- 更新 mistc，修复编译问题
- 修复某些情况读取 Xcode 项目结构错误导致无法预览的问题
- 修复 `string.replace` 函数参数会被当作正则式的问题

## 0.3.31 - 2020-07-23

### Fixed

- 修复预览功能 lines, corner-radius 属性渲染问题
- 更新 mistc，修复编译问题

## 0.3.30 - 2020-07-21

### Improved

- 支持多参数 lambda 表达式和逗号表达式
- 增加 `reduce`, `sort`, `keys` 等函数定义
- 增加 `_platform_`, `is_ios`, `is_android` 预置变量定义
- 支持事件参数 `_event_` 的提示和检查
- 优化错误检查与代码提示

## 0.3.29 - 2020-07-16

### Improved

- 添加 `on-after-layout`, `findNode` 等定义
- 调试服务器请求模板编译错误时弹窗提示

### Fixed

- 修复 `vars` 中的 `$:` 形式的表达式编译后被去掉的问题

## 0.3.28 - 2020-07-15

### Fixed

- 修复布局错误

## 0.3.26 - 2020-07-09

### Improved

- 更新 mistc，支持常量折叠编译优化，生成特定平台产物时能移除多余内容。例如有 "gone": "${!iOS}" 的节点在生成 Android 产物时会直接移除

### Fixed

- 修复某些情况插件初始化失败

## 0.3.25 - 2020-07-06

### Fixed

- 修复 Android 端偶现模板 push 不成功的问题

## 0.3.24 - 2020-07-06

### Fixed

- Mist Outline 不显示时，不自动高亮选中节点

## 0.3.23 - 2020-07-02

### Fixed

- 修复 Mist Outline 中表达式显示为 [Object object] 的问题
- 修复某些情况预览边框显示错位

## 0.3.22 - 2020-07-01

### Fixed

- 修复获取本地图片时读取资源文件夹错误

## 0.3.21 - 2020-07-01

### Added

- 支持 `// @ignore` 忽略下一行的语义检查错误提示

### Improved

- 预览功能支持基线对齐
- Mist Outline 中区分水平/竖直方向容器图标，增加 import 节点图标
- Mist Outline 自动高亮当前选中节点
- 优化数组方法/属性找不到时的错误提示

### Fixed

- 修复 vars 数组中某些情况没有变量提示

## 0.3.20 - 2020-06-24

### Fixed

- 修复 action 的 params 不为 object 时会报错的问题
- 修复某些情况 set_value 函数报错

### Improved

- Android 调试支持指定 mockData 的位置

## 0.3.19 - 2020-06-18

### Fixed

- Android 调试功能兼容没有 bizCode 的情况

## 0.3.18 - 2020-06-16

### Fixed

- 修复 `type` 属性的自动补全功能
- 修复某些情况没有对不支持的属性报错
- 修复在不支持的属性中引用变量后可能还会报错 “未引用的变量”

## 0.3.17 - 2020-06-15

### Fixed

- 修复 "$:exp" 形式表达式中有 "}" 字符时，后续整个模板的语法高亮错误
- 修复一些其他情况的表达式语法高亮问题
- controller 属性支持表达式，避免使用表达式时报错

## 0.3.16 - 2020-06-09

### Fixed

- 修复 Android 调试时不支持中文路径的问题

### Improved

- Android 调试支持 bizCode 为空的配置

## 0.3.15 - 2020-06-03

### Added

- 规范 mock 数据文件格式 `*.mock.json`

### Fixed

- 修复 json 文件修改后预览不能实时更新的问题
- 修复部分情况数组类型检查误报问题

### Improved

- 预览功能优化
  - 添加了一些 Android 预览机型
  - 预览窗口标题中显示模板文件名
  - 打开预览时不转移窗口焦点
- 检查同一个 `vars` 字典中的变量引用，避免未定义行为
- 更新预置变量、函数

## 0.3.14 - 2020-05-06

### Fixed

- 修复 Android 调试时获取设备 IP 问题

### Improved

- postNotification 增加 params 属性
