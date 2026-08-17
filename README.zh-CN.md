# goal-acceptance

![goal-acceptance](docs/goal-acceptance-cover.jpg)

[English](README.md) | 涓枃

闈㈠悜鑷富 AI Agent 鐨勯獙鏀舵爣鍑嗛┍鍔ㄥ紡鐩爣瀹屾垚鏈哄埗銆?
鍦?Agent 寮€濮嬪伐浣滃墠閿佸畾涓嶅彲鍙橀獙鏀舵爣鍑嗭紝鎵ц杩囩▼涓窡韪甫璇佹嵁鐨勯獙璇佺姸鎬侊紝
骞跺湪鐩爣瀹屾垚鍓嶅己鍒舵鏌モ€斺€旈槻姝?Agent 杩囨棭瀹ｅ竷"鍋氬畬浜?銆?
## 浼樺娍

### 1. 璺ㄥ钩鍙板吋瀹?
goal-acceptance 鍏煎**浠讳綍**鏀寔 MCP 鎴?Agent Plugins 鐨?AI agent 骞冲彴銆備竴涓寘锛屽涓繍琛屾椂锛?
| 骞冲彴 | 杩炴帴鏂瑰紡 | Turn-stopping 寮哄埗鎷︽埅 |
|------|---------|----------------------|
| **Claude Code** | MCP stdio server | 妯″瀷鑷璋冪敤宸ュ叿 |
| **Cursor** | MCP stdio server | 妯″瀷鑷璋冪敤宸ュ叿 |
| **Devin** | MCP stdio server | 妯″瀷鑷璋冪敤宸ュ叿 |
| **OpenClaw** | 鍘熺敓鎻掍欢 (`@cckyros/goal-acceptance-openclaw`) 鎴?Agent Plugin bundle | 妯″瀷鑷璋冪敤宸ュ叿 |
| **DeepSeek Harness** | Cordis 鎻掍欢 (`@cckyros/dsh-goal-acceptance`) | **鏄?* 鈥?`agent.steer()` 寮哄埗缁х画 |
| **浠讳綍 MCP 瀹㈡埛绔?* | stdio MCP server | 妯″瀷鑷璋冪敤宸ュ叿 |
| **浠讳綍 Agent Plugins 瀹㈡埛绔?* | plugin.json + mcp.json + skills | 妯″瀷鑷璋冪敤宸ュ叿 |
| **浠讳綍 JS/TS 杩愯鏃?* | 鏍稿績搴?(`@cckyros/goal-acceptance-core`) | 缂栫▼寮?鈥?浣犺嚜宸辨帶鍒?|

鏍稿績鐘舵€佹満**闆朵緷璧?*锛屽彲鍦ㄤ换浣?JS/TS 杩愯鏃朵腑杩愯锛圢ode.js銆丅un銆丏eno銆佹祻瑙堝櫒锛夈€?MCP server 浠呭鍔?MCP SDK銆侰ordis 鎻掍欢澧炲姞 DeepSeek Harness 闆嗘垚銆傛寜闇€閫夋嫨灞傜骇銆?
### 2. MCP server 鎻愪緵 12 涓伐鍏?
MCP server 鏆撮湶 12 涓伐鍏凤紝瑕嗙洊瀹屾暣鐨?goal-acceptance 鐢熷懡鍛ㄦ湡锛?
- **鏍囧噯绠＄悊**锛歴et銆乬et銆乤mend
- **浠诲姟璁″垝绠＄悊**锛歴et task plan銆乬et task plan
- **楠岃瘉**锛歷alidate criterion锛堝甫绫诲瀷鍖栬瘉鎹級
- **杩涘害璺熻釜**锛歶pdate task status
- **瀹屾垚闂ㄦ帶**锛歝an complete goal
- **澶?goal 绠＄悊**锛歴tart goal銆乴ist goals銆乻witch goal銆乺eset goal

瀹屾暣鍒楄〃瑙佷笅鏂?[MCP 宸ュ叿](#mcp-宸ュ叿)銆?
### 澶?goal 闅旂

姣忎釜 goal 鏈夌嫭绔嬬殑浜嬩欢鏂囦欢 `${PLUGIN_DATA}/goals/{goalId}.json` 鈥?澶氫釜椤圭洰/绐楀彛鍙互鍏变韩涓€涓?server 鑰屼笉鍐茬獊锛?
- `set_acceptance_criteria` 鍦ㄦ病鏈夋椿璺?goal 鏃惰嚜鍔ㄥ垱寤轰竴涓?- `start_goal` 寮€鍚柊鐨勭嫭绔?goal锛堝叏鏂版爣鍑?+ 浠诲姟璁″垝锛?- `switch_goal` 鍦?goal 涔嬮棿鍒囨崲锛沗list_goals` 鍒楀嚭鎵€鏈?goal 鍙婄姸鎬?- `reset_goal` 鍒犻櫎褰撳墠 goal锛屽彲浠ラ噸鏂板紑濮?- 娲昏穬 goal 璺ㄩ噸鍚繚鐣欙紙`current-goal.txt`锛?
### 3. 鍙岃鑹查獙璇侊紙闃茶嚜璇勶級

`set_acceptance_criteria` 鎺ュ彈 `role` 鍙傛暟锛坄agent` / `reviewer` / `dual`锛夈€?褰?`role=agent` 鏃讹紝`validate_criterion` 鏍囪 `passed` 涓?`selfClaimed=true` 鈥?`can_complete_goal` 浼氶樆姝㈠畬鎴愶紝鐩村埌 reviewer 姝ｅ紡纭銆傝繖鎵撶牬浜?Agent
"鏃㈠共娲诲張缁欒嚜宸辩洊鍚堟牸绔?鐨勮嚜璇勫惊鐜€?
### 4. 绫诲瀷鍖栬瘉鎹?
`validate_criterion` 鎺ュ彈 `evidence_type`锛坄command` / `file` / `url` / `text`锛夈€?`text` 璇佹嵁鏍囪 `lowConfidence=true`锛宺eviewer 鍙竴鐪艰瘑鍒富瑙傚０鏄庛€?`command` 璇佹嵁锛堟祴璇曡緭鍑恒€丆LI 缁撴灉锛変负楂樺彲淇°€?
### 5. 浠诲姟鍒嗚В涓庝緷璧栨牎楠?
`set_task_plan` 灏嗙洰鏍囧垎瑙ｄ负鍘熷瓙浠诲姟锛屾瘡涓换鍔″甫鍏蜂綋浜や粯鐗┿€?寮曟搸鏍￠獙锛氬敮涓€ ID銆佹棤姝т箟鎻忚堪銆侀潪绌轰氦浠樼墿銆佹棤鑷緷璧栥€佹棤鏈煡渚濊禆銆佹棤渚濊禆鐜紙鍚棿鎺ョ幆锛夈€?
### 6. 浜嬩欢婧簮鎸佷箙鍖?
鎵€鏈夌姸鎬佸彉鏇翠负鍙拷鍔犱簨浠躲€傚紩鎿庢瘡娆¤鍙栨椂閲嶆斁浜嬩欢锛屾敮鎸佹寔涔呭寲瀛樺偍銆?璺ㄩ噸鍚簿纭姸鎬佹仮澶嶃€佷互鍙婂畬鏁寸殑鍐崇瓥瀹¤杞ㄨ抗銆?
### 7. 榛樿绮剧畝鍝嶅簲

MCP 宸ュ叿鍝嶅簲榛樿绮剧畝锛? 瀛楁鎽樿锛夈€備紶 `verbose=true` 鑾峰彇瀹屾暣鎽樿銆?姝ｅ父鎿嶄綔鏃舵渶灏忓寲 token 寮€閿€銆?
## 鍖呯粨鏋?
| 鍖?| 鎻忚堪 | 渚濊禆 |
|----|------|------|
| [`@cckyros/goal-acceptance-core`](packages/goal-acceptance-core) | 妗嗘灦鏃犲叧鐘舵€佹満銆佺被鍨嬨€侀敊璇爜銆佹娊璞?store | 鏃?|
| [`@cckyros/goal-acceptance-mcp`](packages/goal-acceptance-mcp) | MCP stdio server + Agent Plugin 鎵撳寘锛坧lugin.json銆乵cp.json銆乻kills锛?| core銆丮CP SDK |
| [`@cckyros/goal-acceptance-openclaw`](packages/goal-acceptance-openclaw) | OpenClaw 鍘熺敓鎻掍欢锛堣繘绋嬪唴宸ュ叿锛屾棤 stdio 寮€閿€锛?| core銆乼ypebox锛沺eer: openclaw |
| [`@cckyros/dsh-goal-acceptance`](packages/goal-acceptance) | DeepSeek Harness Cordis 鎻掍欢锛屽甫 turn-stopping 寮哄埗 steering | core銆乻chemastery锛沺eer: dsh-* 鍖?|

## 鏋舵瀯

```
                    鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                    鈹?@cckyros/goal-acceptance-core                   鈹?                    鈹?(闆朵緷璧栫姸鎬佹満锛屼簨浠舵函婧?                         鈹?                    鈹斺攢鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                       鈹?             鈹?              鈹?          鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹粹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹€鈹粹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹粹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?          鈹?@cckyros/goal-     鈹?鈹?@cckyros/    鈹?鈹?@cckyros/dsh-goal-      鈹?          鈹?acceptance-mcp     鈹?鈹?goal-        鈹?鈹?acceptance              鈹?          鈹?(MCP stdio server +鈹?鈹?acceptance-  鈹?鈹?(DeepSeek Harness       鈹?          鈹? Agent Plugin      鈹?鈹?openclaw     鈹?鈹? Cordis 鎻掍欢)           鈹?          鈹? 鎵撳寘)             鈹?鈹?(OpenClaw    鈹?鈹?turn-stopping           鈹?          鈹?12 涓伐鍏凤紝stdio    鈹?鈹? 鍘熺敓)       鈹?鈹?agent.steer()           鈹?          鈹?skills/ 鍖呭惈       鈹?鈹?12 涓伐鍏凤紝  鈹?鈹?绯荤粺鎻愮ず璇?             鈹?          鈹?                   鈹?鈹?杩涚▼鍐?      鈹?鈹?宸ュ叿娉ㄥ唽                鈹?          鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?```

## 蹇€熷紑濮?
### 鏍稿績搴擄紙浠讳綍 JS/TS 杩愯鏃讹級

```sh
npm install @cckyros/goal-acceptance-core
```

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

// 宸ヤ綔寮€濮嬪墠閿佸畾楠屾敹鏍囧噯
await engine.setCriteria([
  { id: 'api-200', description: 'GET /health 杩斿洖 200', required: true, method: 'test' },
  { id: 'docs', description: 'README 宸叉洿鏂?, required: false, method: 'manual' },
])

// 璁板綍楠岃瘉缁撴灉鍜岃瘉鎹?await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health 鈫?HTTP 200 OK',
})

// 妫€鏌ョ洰鏍囨槸鍚﹀彲浠ュ畬鎴?const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
// 鈫?true, undefined
```

### MCP server锛圖evin銆丆laude Code銆丆ursor 绛夛級

涓夌瀹夎鏂瑰紡锛屼换閫夊叾涓€锛?
#### 鏂瑰紡 A锛氬叏灞€瀹夎锛堟帹鑽愶級

```sh
npm install -g @cckyros/goal-acceptance-mcp
```

鎵惧埌瀹夎璺緞锛岀劧鍚庢坊鍔犲埌 MCP 瀹㈡埛绔厤缃細

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["/path/to/global/node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

> **鏌ユ壘鍏ㄥ眬璺緞**锛歚npm root -g`锛圵indows 濡?`C:\nvm4w\nodejs\node_modules`锛宮acOS/Linux 濡?`/usr/local/lib/node_modules`锛夈€?
#### 鏂瑰紡 B锛歯px锛堟棤闇€棰勮锛?
npx 鎸夐渶涓嬭浇鍒颁复鏃剁紦瀛橈紝鏃犻渶鍏ㄥ眬瀹夎锛屼絾棣栨鍚姩鏈夊嚑绉掍笅杞藉欢杩熴€?
```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "npx",
      "args": ["-y", "@cckyros/goal-acceptance-mcp"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

> **Windows + nvm 鐢ㄦ埛**锛氬鏋?npx 鍚姩澶辫触锛屾敼鐢ㄦ柟寮?A銆俷vm 鐨?junction 绗﹀彿閾炬帴鍙兘瀵艰嚧 `import.meta.url` 璺緞涓嶅尮閰嶃€?
#### 鏂瑰紡 C锛氶」鐩骇瀹夎

```sh
npm install @cckyros/goal-acceptance-mcp
```

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

#### Devin CLI 閰嶇疆

Devin 鐨勯厤缃枃浠跺湪 `%APPDATA%\devin\mcp_config.json`锛圵indows锛夋垨 `~/.config/devin/mcp_config.json`锛坢acOS/Linux锛夈€傜敤涓婅堪浠讳竴鏂瑰紡娣诲姞 `goal-acceptance` 鍒?`mcpServers`锛岀劧鍚庨噸鍚?Devin銆?
#### 鐩存帴杩愯

```sh
# 鍐呭瓨妯″紡锛堥噸鍚悗閲嶇疆锛?node ./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs

# 鎸佷箙鍖栨ā寮忥紙璺ㄩ噸鍚繚鐣欙級
PLUGIN_DATA=/path/to/data node ./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs
```

server 鍦?`$PLUGIN_DATA` 涓嬪啓鍏?`acceptance-events.json`銆傛湭璁剧疆 `PLUGIN_DATA`
鏃剁姸鎬佷粎鍦ㄥ唴瀛樹腑锛堥噸鍚涪澶憋級銆?
#### 鍏稿瀷宸ヤ綔娴?
1. **璁炬爣鍑?* 鈥?`set_acceptance_criteria`锛宍role=reviewer`锛堜綘楠岃瘉锛夋垨 `role=agent`锛坅gent 鑷瘎锛屼綘鍚庣画纭锛?2. **璁句换鍔¤鍒?* 鈥?`set_task_plan` 灏嗙洰鏍囧垎瑙ｄ负甯︿氦浠樼墿鍜屼緷璧栫殑鍘熷瓙浠诲姟
3. **鎵ц** 鈥?`update_task_status` 璺熻釜浠诲姟杩涘害锛坄pending` 鈫?`in_progress` 鈫?`completed`锛?4. **楠岃瘉** 鈥?`validate_criterion`锛岀敤 `evidence_type=command` 鎻愪緵楂樺彲淇¤瘉鎹?5. **妫€鏌?* 鈥?`can_complete_goal` 纭鎵€鏈?required 鏍囧噯姝ｅ紡閫氳繃

### OpenClaw 鍘熺敓鎻掍欢

`@cckyros/goal-acceptance-openclaw` 鏄?OpenClaw 鍘熺敓鎻掍欢锛岀洿鎺ュ湪杩涚▼鍐呮敞鍐屽叏閮?12 涓伐鍏凤紙鏃?MCP stdio 寮€閿€锛夈€?
```sh
openclaw plugins install "npm:@cckyros/goal-acceptance-openclaw@rc"
```

> **娉ㄦ剰**锛歚@rc` 鏍囩鏄繀椤荤殑锛屽洜涓哄寘澶勪簬棰勫彂甯冮樁娈点€傚彂甯冪ǔ瀹氱増鍚庡彲鐪佺暐鏍囩銆?
瀹夎鍚庨噸鍚?gateway锛?
```sh
openclaw gateway restart
```

楠岃瘉锛?
```sh
openclaw plugins inspect goal-acceptance
# Status: loaded, Format: openclaw
```

12 涓伐鍏风幇鍦ㄥ湪 OpenClaw 浼氳瘽涓彲鐢ㄣ€俙Shape: non-capability` 鏄?tool 鎻掍欢鐨勬甯哥姸鎬佲€斺€斿伐鍏烽€氳繃 `defineToolPlugin` 娉ㄥ唽锛屼笉璧?capability 绯荤粺銆?
### Agent Plugin锛堝彲绉绘 bundle 鏍煎紡锛?
MCP 鍖呭悓鏃朵篃鏄鍚?[Agent Plugins](https://agent-plugins.org) 鏍囧噯鐨勬彃浠跺寘銆?灏嗕换浣曟敮鎸?Agent Plugins 鐨勫鎴风鎸囧悜鍖呮牴鐩綍鍗冲彲锛?
```
node_modules/@cckyros/goal-acceptance-mcp/
鈹溾攢鈹€ plugin.json    # Agent Plugin 娓呭崟
鈹溾攢鈹€ mcp.json       # stdio MCP server 閰嶇疆
鈹斺攢鈹€ skills/        # 鍙Щ妞?Agent Skills
    鈹溾攢鈹€ set-acceptance-criteria/SKILL.md
    鈹溾攢鈹€ get-acceptance-criteria/SKILL.md
    鈹溾攢鈹€ validate-criterion/SKILL.md
    鈹溾攢鈹€ update-task-status/SKILL.md
    鈹溾攢鈹€ amend-acceptance-criteria/SKILL.md
    鈹斺攢鈹€ can-complete-goal/SKILL.md
```

瀹㈡埛绔細鑷姩鍙戠幇 skills銆佸惎鍔?stdio MCP server銆佹毚闇插伐鍏枫€?
### DeepSeek Harness锛圕ordis 鎻掍欢锛?
Cordis 鎻掍欢鏄敮涓€鑳?*寮哄埗** Agent 鍦ㄥ皾璇曟彁鍓嶅仠姝㈡椂缁х画宸ヤ綔鐨勫彉浣撱€?瀹冩嫤鎴?`agent/turn-stopping`锛屾寜渚濊禆浼樺厛绾?steer Agent 缁х画銆?
```sh
npm install @cckyros/dsh-goal-acceptance
```

```yaml
# cordis.yml
plugins:
  goal-acceptance:
    autoSteerUncompleted: true
    maxSteeringTurns: 5
```

鎻掍欢鍔熻兘锛?- 娉ㄥ唽 5 涓ā鍨嬪伐鍏凤紙`set/get/validate_acceptance_criteria`銆乣update_task_status`銆乣amend_acceptance_criteria`锛?- 娉ㄥ叆 `policy:goal-acceptance` 绯荤粺鎻愮ず璇嶏紝鍚换鍔¤繘搴﹀拰涓嬩竴姝ヨ鍔ㄦ帓搴?- 鎷︽埅 `agent/turn-stopping`锛屽綋 required 鏍囧噯鏈畬鎴愭椂鎸変緷璧栦紭鍏堢骇 steer Agent 缁х画

> **娉ㄦ剰**锛欳ordis 鎻掍欢闇€瑕?DeepSeek Harness 鍖呬綔涓?peer 渚濊禆
>锛坄@deepseek-ai/dsh-agent`銆乣dsh-llm`銆乣dsh-session`銆乣dsh-tools`銆?> `dsh-system-prompt`銆乣dsh-goal`銆乣dsh-invariants`銆乣cordis`锛夈€?> 闇€鍦?DeepSeek Harness 椤圭洰涓畨瑁咃紙杩欎簺 peer 宸插瓨鍦級銆俢ore 鍜?mcp 鍖呭彲鐙珛鏋勫缓銆?
## MCP 宸ュ叿

| 宸ュ叿 | 鎻忚堪 |
|------|------|
| `set_acceptance_criteria` | 閿佸畾鏍囧噯鍒楄〃銆傛瘡涓爣鍑嗗彲鍏宠仈 task ID 鍜屼緷璧栥€傚彲閫?`role` 鍙傛暟锛坄agent`/`reviewer`/`dual`锛岄粯璁?`dual`锛夋帶鍒惰嚜璇勮涓恒€傚繀椤诲湪瀹炵幇鍓嶈皟鐢ㄣ€?|
| `get_acceptance_criteria` | 璇诲彇褰撳墠鏍囧噯銆佷换鍔¤繘搴︺€佹憳瑕併€佷换鍔¤鍒掋€佸彲楠岃瘉鍒楄〃鍜屼笅涓€姝ヨ鍔ㄦ帓搴忋€傚彲閫?`verbose`锛堥粯璁?`true`锛涗紶 `false` 浠呰繑鍥炵簿绠€鎽樿锛夈€?|
| `set_task_plan` | 璁惧畾骞堕攣瀹氫换鍔″垎瑙ｈ鍒掋€傛瘡涓换鍔￠渶鍞竴 id銆佹棤姝т箟鎻忚堪銆佸叿浣撲氦浠樼墿銆備緷璧栫幆琚嫆缁濄€傞渶鍏堥攣瀹氭爣鍑嗐€?|
| `get_task_plan` | 璇诲彇褰撳墠浠诲姟鍒嗚В璁″垝鍙婂疄鏃朵换鍔＄姸鎬併€?|
| `validate_criterion` | 璁板綍鐘舵€侊紙`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`锛夊拰璇佹嵁銆俙passed` 鍜?`failed` 闇€瑕佽瘉鎹€傚彲閫?`evidence_type`锛坄command`/`file`/`url`/`text`锛岄粯璁?`text`锛夈€傚綋 `role=agent` 鏃?`passed` 鏍囪涓鸿嚜璇勩€傚彲閫?`verbose`锛堥粯璁?`false`锛夈€?|
| `update_task_status` | 鏇存柊鍏宠仈浠诲姟鐨勭姸鎬侊紙`pending`/`in_progress`/`completed`/`failed`锛夈€傚綋鏍囧噯鍏宠仈鐨勬墍鏈変换鍔″畬鎴愭椂锛岃鏍囧噯鍙樹负鍙獙璇併€傚彲閫?`verbose`锛堥粯璁?`false`锛夈€?|
| `amend_acceptance_criteria` | 鍦ㄥ垵濮嬮攣瀹氬悗杩藉姞鏂版爣鍑嗐€傞渶瑕佺悊鐢便€傚凡鏈夋爣鍑嗕笉琚慨鏀广€?|
| `can_complete_goal` | 妫€鏌ユ墍鏈?required 鏍囧噯鏄惁姝ｅ紡閫氳繃锛堣嚜璇勪笉绠楋級銆傝繑鍥?`{ allowed: boolean, reason?: string }`銆?|
| `start_goal` | 寮€鍚柊鐨勭嫭绔?goal锛堝彲閫?`title`锛夛紝鏂?goal 鎴愪负娲昏穬 goal銆傚綋鍓?goal 閿佸畾鍚庨渶瑕佹柊浠诲姟鏃朵娇鐢ㄣ€?|
| `list_goals` | 鍒楀嚭鎵€鏈?goal锛屽惈 ID銆佹爣棰樸€佹爣鍑嗘暟銆佹椿璺冩爣蹇椼€?|
| `switch_goal` | 鍒囨崲娲昏穬 goal 鍒板凡鏈?goal锛堟寜 ID锛夈€?|
| `reset_goal` | 姘镐箙鍒犻櫎褰撳墠 goal 鍙婂叾鎵€鏈夋暟鎹€?|

## 鏍囧噯鐘舵€佺敓鍛藉懆鏈?
```
                    鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                    鈹?pending  鈹?鈫?setCriteria 鍚庣殑鍒濆鐘舵€?                    鈹斺攢鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹?                         鈹?              鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?              鈹?         鈹?         鈹?              鈻?         鈻?         鈻?        鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?        鈹俰n_progress鈹?鈹?passed 鈹?鈹?failed 鈹?        鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?              鈹?         鈹?         鈹?              鈹?         鈹?    鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?              鈹?         鈹?    鈹俠locked 鈹?              鈹?         鈹?    鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?              鈹?         鈹?    鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?              鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹樷攢鈹€鈹€鈹€鈹€鈹俷ot_run 鈹?                                鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?```

| 鐘舵€?| 鍚箟 | 鏄惁闇€瑕佽瘉鎹?|
|------|------|:---:|
| `pending` | 灏氭湭寮€濮?| 鍚?|
| `in_progress` | 姝ｅ湪杩涜 | 鍚?|
| `passed` | 楠岃瘉閫氳繃 | 鏄?|
| `failed` | 楠岃瘉澶辫触 | 鏄?|
| `blocked` | 褰撳墠鐜鏃犳硶楠岃瘉 | 鍚?|
| `not_run` | 鏄惧紡璺宠繃锛堜粎闈?required锛?| 鍚?|

## 瀹屾垚闂ㄦ帶

`canComplete()` 杩斿洖 `{ allowed: boolean, reason?: string }`锛?
- **鍏佽**锛氭墍鏈?required 鏍囧噯姝ｅ紡 `passed`锛堥潪鑷瘎锛夛紝鎴栨湭閿佸畾浠讳綍鏍囧噯銆?- **涓嶅厑璁?*锛氫换浣?required 鏍囧噯涓?`pending`銆乣in_progress`銆乣failed`銆乣blocked` 鎴?`not_run`銆?- **涓嶅厑璁革紙鑷瘎锛?*锛氭墍鏈?required 鏍囧噯涓?`passed` 浣嗛儴鍒嗕负 `selfClaimed=true`锛堢敱 agent 璁剧疆锛屾湭缁?reviewer 纭锛夈€俽eason 浼氭寚鍑烘湁澶氬皯鏉″緟纭銆?
## 浜嬩欢婧簮

寮曟搸閲囩敤浜嬩欢婧簮妯″紡銆俿tore 鎸佹湁鍙拷鍔犵殑浜嬩欢鍒楄〃锛?
- `goal-acceptance/set` 鈥?閿佸畾鏍囧噯鍒楄〃锛堝惈 role锛?- `goal-acceptance/task-plan` 鈥?閿佸畾浠诲姟鍒嗚В璁″垝
- `goal-acceptance/validate` 鈥?鏇存柊鍗曚釜鏍囧噯鐨勭姸鎬侊紙鍚瘉鎹被鍨嬨€佽嚜璇勬爣璁帮級
- `goal-acceptance/task-update` 鈥?鏇存柊鍏宠仈浠诲姟鐨勭姸鎬?- `goal-acceptance/amend` 鈥?鍦ㄥ垵濮嬮攣瀹氬悗杩藉姞鏂版爣鍑?
姣忔璇诲彇鏃讹紝寮曟搸浠?store 閲嶆斁浜嬩欢銆傝繖浣垮緱锛?
- 鎸佷箙鍖栧瓨鍌紙鏂囦欢銆佹暟鎹簱銆乻ession log锛?- 绮剧‘閲嶆斁鐨勭姸鎬佹仮澶?- 鎵€鏈夊喅绛栫殑瀹¤杞ㄨ抗

### 鑷畾涔?Store

涓轰綘鐨勬寔涔呭寲鍚庣瀹炵幇 `GoalAcceptanceStore`锛?
```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from '@cckyros/goal-acceptance-core'

class MyDbStore implements GoalAcceptanceStore {
  get events(): readonly GoalAcceptanceEvent[] {
    // 鎸夎拷鍔犻『搴忚繑鍥炴墍鏈変簨浠?  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // 鎸佷箙鍖栦簨浠?  }
}
```

## 涓夋柟鍏煎鎬?
| 鑳藉姏 | Cordis 鎻掍欢 | MCP server | Agent Plugin | OpenClaw 鍘熺敓鎻掍欢 |
|------|:---:|:---:|:---:|:---:|
| 妯″瀷宸ュ叿 | `set/get/validate/update_task/amend` | 12 涓伐鍏凤紙瑙?[MCP 宸ュ叿](#mcp-宸ュ叿)锛?| 鍚?MCP | 鍚?MCP锛堣繘绋嬪唴锛?|
| 绯荤粺鎻愮ず璇?/ Skills | `policy:goal-acceptance` | `skills/` | `skills/` | `skills/` |
| Turn-stopping 寮哄埗鎷︽埅 | 鏄紙`agent.steer()`锛?| 鍚?| 鍚?| 鍚?|
| 璺ㄥ鎴风鍙Щ妞?| 鍚︼紙浠?Harness锛?| 鏄紙浠讳綍 MCP 瀹㈡埛绔級 | 鏄紙浠讳綍 Agent Plugins 瀹㈡埛绔級 | 鍚︼紙浠?OpenClaw锛?|
| 鎸佷箙鍖栫姸鎬?| `dsh-session` 鏃ュ織 | `$PLUGIN_DATA/acceptance-events.json` | 鍚?MCP | 鍚?MCP |
| 鍙岃鑹查獙璇?| 鍚?| 鏄紙`role` 鍙傛暟锛?| 鏄?| 鏄?|
| 绫诲瀷鍖栬瘉鎹?| 鍚?| 鏄紙`evidence_type` 鍙傛暟锛?| 鏄?| 鏄?|
| 浠诲姟鍒嗚В璁″垝 | 鍚?| 鏄紙`set_task_plan` / `get_task_plan`锛?| 鏄?| 鏄?|
| 绮剧畝鍝嶅簲 | 鍚?| 鏄紙`verbose` 鍙傛暟锛?| 鏄?| 鏄?|
| 杩涚▼鍐呰皟鐢紙鏃?stdio锛?| 鏄?| 鍚?| 鍚?| 鏄?|

Cordis 鎻掍欢鏄敮涓€鑳?*寮哄埗** Agent 鍦ㄥ皾璇曟彁鍓嶅仠姝㈡椂缁х画宸ヤ綔鐨勫彉浣撱€?MCP 鍜?Agent Plugin 鍙樹綋渚濊禆妯″瀷鑷璋冪敤宸ュ叿骞堕伒寰?skill 鎸囦护銆?
## 浠撳簱甯冨眬

```
packages/
鈹溾攢鈹€ goal-acceptance-core/       # 闆朵緷璧栫姸鎬佹満
鈹?  鈹溾攢鈹€ src/
鈹?  鈹?  鈹溾攢鈹€ engine.ts           # GoalAcceptanceEngine
鈹?  鈹?  鈹溾攢鈹€ store.ts            # GoalAcceptanceStore + InMemoryAcceptanceStore
鈹?  鈹?  鈹溾攢鈹€ types.ts            # GoalCriterion銆丄cceptanceSummary銆佷簨浠?鈹?  鈹?  鈹溾攢鈹€ errors.ts           # GoalAcceptanceError
鈹?  鈹?  鈹斺攢鈹€ index.ts            # 鍏紑瀵煎嚭
鈹?  鈹斺攢鈹€ tests/
鈹?      鈹溾攢鈹€ engine.spec.ts      # 51 涓祴璇?鈹?      鈹斺攢鈹€ standalone.spec.ts  # 1 涓祴璇?鈹溾攢鈹€ goal-acceptance-mcp/        # MCP server + Agent Plugin
鈹?  鈹溾攢鈹€ src/
鈹?  鈹?  鈹溾攢鈹€ mcp-server.ts       # stdio MCP server锛?2 涓伐鍏?鈹?  鈹?  鈹溾攢鈹€ store.ts            # FileAcceptanceStore
鈹?  鈹?  鈹斺攢鈹€ index.ts
鈹?  鈹溾攢鈹€ bin/mcp-server.mjs      # 鏋勫缓鍚庣殑 stdio 鍏ュ彛
鈹?  鈹溾攢鈹€ plugin.json             # Agent Plugins 娓呭崟
鈹?  鈹溾攢鈹€ mcp.json                # MCP server 閰嶇疆
鈹?  鈹溾攢鈹€ skills/                 # 鍙Щ妞?Agent Skills锛? 涓?skill锛?鈹?  鈹斺攢鈹€ tests/
鈹?      鈹斺攢鈹€ mcp-server.spec.ts  # 22 涓祴璇?鈹溾攢鈹€ goal-acceptance-openclaw/   # OpenClaw 鍘熺敓鎻掍欢
鈹?  鈹溾攢鈹€ src/
鈹?  鈹?  鈹斺攢鈹€ index.ts            # defineToolPlugin锛?2 涓伐鍏凤紙杩涚▼鍐咃級
鈹?  鈹溾攢鈹€ dist/index.js           # 鏋勫缓鍚庣殑鍏ュ彛
鈹?  鈹溾攢鈹€ openclaw.plugin.json    # OpenClaw 鎻掍欢娓呭崟
鈹?  鈹斺攢鈹€ skills/                 # 鍙Щ妞?Agent Skills锛?2 涓?skill锛?鈹斺攢鈹€ goal-acceptance/            # DeepSeek Harness Cordis 鎻掍欢
    鈹溾攢鈹€ src/
    鈹?  鈹溾攢鈹€ index.ts            # apply(): service + tools + prompt + turn-stopping
    鈹?  鈹溾攢鈹€ service.ts          # GoalAcceptanceService锛堟瘡 Agent 涓€涓紩鎿庯級
    鈹?  鈹溾攢鈹€ store.ts            # SessionAcceptanceStore锛坉sh-session 閫傞厤鍣級
    鈹?  鈹溾攢鈹€ tools.ts            # 3 涓ā鍨嬪伐鍏?    鈹?  鈹溾攢鈹€ prompt.ts           # 绯荤粺鎻愮ず璇?    鈹?  鈹溾攢鈹€ types.ts            # SessionEventMap 澹版槑
    鈹?  鈹斺攢鈹€ invariant.ts        # 杩愯鏃朵笉鍙樺紡
    鈹斺攢鈹€ tests/
        鈹溾攢鈹€ service.spec.ts     # 5 涓祴璇?        鈹溾攢鈹€ tools.spec.ts       # 3 涓祴璇?        鈹溾攢鈹€ plugin.spec.ts      # 4 涓祴璇?        鈹斺攢鈹€ invariant.spec.ts   # 1 涓祴璇?```

## 鏋勫缓

```sh
pnpm install
pnpm run build
```

鏋勫缓 core 鍜?mcp 鍖呫€侰ordis 鎻掍欢锛坄goal-acceptance`锛夐渶瑕?DeepSeek Harness
workspace锛屽湪鏈粨搴撲腑榛樿涓嶆瀯寤恒€?
## 娴嬭瘯

```sh
pnpm install
pnpm test
```

## 璁稿彲璇?
MIT
