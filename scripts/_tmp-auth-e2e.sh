#!/usr/bin/env bash
# 临时端到端验证脚本（验证完即删）：T02 认证与会话
# 用法：bash scripts/_tmp-auth-e2e.sh
set -u
BASE=http://localhost:3000/api
PASS=0; FAIL=0
green() { printf '\033[32m✓\033[0m %s\n' "$1"; }
red()   { printf '\033[31m✗\033[0m %s\n' "$1"; }
check() { # check <name> <expected-substring> <actual>
  if echo "$3" | grep -q "$2"; then green "$1"; PASS=$((PASS+1));
  else red "$1"; echo "    期望包含: $2"; echo "    实际: $(echo "$3" | head -c 400)"; FAIL=$((FAIL+1)); fi
}
jqr() { # 从 JSON 里取字段（无 jq 时用 grep+sed）
  echo "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1
}

echo "===== 场景 1：新用户注册 → 用 token 访问 ====="
REG=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"bob@xulian.test","password":"test1234","displayName":"Bob"}')
BOB_TOKEN=$(jqr "$REG" token)
BOB_UID=$(jqr "$REG" id)
check "注册成功返回 token" '"ok":true' "$REG"
[ -n "$BOB_TOKEN" ] && green "拿到 token（长度 ${#BOB_TOKEN}）" && PASS=$((PASS+1)) || { red "没拿到 token"; FAIL=$((FAIL+1)); }

ME=$(curl -s $BASE/auth/me -H "Authorization: Bearer $BOB_TOKEN")
check "用 token 取 /api/auth/me" '"email":"bob@xulian.test"' "$ME"

echo
echo "===== 场景 2：伪造 X-User-Id 冒充已注册账号 ====="
IMPERSONATE=$(curl -s -o .tmp-e2e/imp.json -w '%{http_code}' $BASE/auth/me -H "X-User-Id: $BOB_UID")
check "伪造 X-User-Id（已注册账号）→ 401" '401' "$IMPERSONATE"
echo "    响应体: $(cat .tmp-e2e/imp.json)"
IMPERSONATE2=$(curl -s -o .tmp-e2e/imp.json -w '%{http_code}' $BASE/characters -H "X-User-Id: $BOB_UID")
check "伪造 X-User-Id 访问角色列表 → 401" '401' "$IMPERSONATE2"

echo
echo "===== 场景 3：坏 token 不回落到 X-User-Id ====="
BAD=$(curl -s -o .tmp-e2e/bad.json -w '%{http_code}' $BASE/auth/me \
  -H "Authorization: Bearer this.is.not.a.valid.token" -H "X-User-Id: $BOB_UID")
check "坏 token + 合法 X-User-Id → 401（不回落）" '401' "$BAD"
echo "    响应体: $(cat .tmp-e2e/bad.json)"

echo
echo "===== 场景 4：老匿名账号（test-user-001）注册 → 数据零丢失 ====="
BEFORE=$(curl -s "$BASE/users/bootstrap?userId=test-user-001")
BEFORE_CHARS=$(echo "$BEFORE" | grep -o '"id":"[^"]*"' | wc -l)
BEFORE_NAMES=$(echo "$BEFORE" | grep -o '"name":"[^"]*"' | head -5 | tr '\n' ' ')
echo "    注册前 bootstrap: 角色名 = $BEFORE_NAMES"
check "匿名模式 bootstrap 可用" '"ok":true' "$BEFORE"

ATTACH=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"olduser@xulian.test","password":"test1234","displayName":"老用户","attachUserId":"test-user-001"}')
check "带 attachUserId 注册成功" '"ok":true' "$ATTACH"
echo "    返回 userId: $(jqr "$ATTACH" id)  ← 必须与 test-user-001 相同"
check "复用同一个 users 行（不是新建）" '"id":"test-user-001"' "$ATTACH"

OLD_TOKEN=$(jqr "$ATTACH" token)
AFTER=$(curl -s $BASE/users/bootstrap -H "Authorization: Bearer $OLD_TOKEN")
AFTER_NAMES=$(echo "$AFTER" | grep -o '"name":"[^"]*"' | head -5 | tr '\n' ' ')
echo "    注册后 bootstrap: 角色名 = $AFTER_NAMES"
if [ "$BEFORE_NAMES" = "$AFTER_NAMES" ] && [ -n "$AFTER_NAMES" ]; then
  green "历史角色一条不丢（注册前后角色名完全一致）"; PASS=$((PASS+1))
else
  red "历史角色丢失或不一致"; FAIL=$((FAIL+1))
fi

echo
echo "===== 场景 4b：用 token 进主页（bootstrap 拿到真实数据）====="
HOME_DATA=$(curl -s $BASE/users/bootstrap -H "Authorization: Bearer $OLD_TOKEN")
check "token 调 /api/users/bootstrap → 200 且有角色" '"defaultCharacterId"' "$HOME_DATA"
check "bootstrap 返回 hasPassword=true" '"hasPassword":true' "$HOME_DATA"
echo "    角色数: $(echo "$HOME_DATA" | grep -o '"runtime"' | wc -l)"
NO_TOKEN_BOOTSTRAP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/users/bootstrap?userId=test-user-001")
check "已注册账号无 token 访问 bootstrap → 401" '401' "$NO_TOKEN_BOOTSTRAP"

echo
echo "===== 场景 5：登录 / 改密码后其他会话失效 ====="
LOGIN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@xulian.test","password":"test1234"}')
TOKEN_A=$(jqr "$LOGIN" token)
check "登录成功" '"ok":true' "$LOGIN"
LOGIN2=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"bob@xulian.test","password":"test1234"}')
TOKEN_B=$(jqr "$LOGIN2" token)
SESSIONS=$(curl -s $BASE/auth/sessions -H "Authorization: Bearer $TOKEN_A")
check "列出会话（应有 3 条：注册+两次登录）" '"current":true' "$SESSIONS"

BADLOGIN=$(curl -s -o .tmp-e2e/badlogin.json -w '%{http_code}' -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"bob@xulian.test","password":"wrongpass1"}')
check "错误密码 → 401" '401' "$BADLOGIN"
echo "    响应体: $(cat .tmp-e2e/badlogin.json)"

CHANGE=$(curl -s -X PATCH $BASE/auth/password -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN_A" \
  -d '{"oldPassword":"test1234","newPassword":"newpass5678"}')
check "改密码成功" '"ok":true' "$CHANGE"
echo "    改密码响应: $CHANGE"

AFTER_A=$(curl -s -o /dev/null -w '%{http_code}' $BASE/auth/me -H "Authorization: Bearer $TOKEN_A")
check "当前会话（TOKEN_A）仍然有效 → 200" '200' "$AFTER_A"
AFTER_B=$(curl -s -o /dev/null -w '%{http_code}' $BASE/auth/me -H "Authorization: Bearer $TOKEN_B")
check "其他会话（TOKEN_B）已失效 → 401" '401' "$AFTER_B"
AFTER_C=$(curl -s -o /dev/null -w '%{http_code}' $BASE/auth/me -H "Authorization: Bearer $BOB_TOKEN")
check "注册时的会话（BOB_TOKEN）已失效 → 401" '401' "$AFTER_C"

echo
echo "===== 场景 6：暴力破解保护（连续 10 次失败 → 锁定 15 分钟）====="
echo "    注：改密码会重置失败计数（这也是正确行为），所以这里重新数 10 次"
for i in $(seq 1 10); do
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"bob@xulian.test","password":"wrongpass1"}')
  printf '    第 %2d 次失败 → HTTP %s\n' "$i" "$R"
done
LOCKED=$(curl -s -o .tmp-e2e/lock.json -w '%{http_code}' -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"bob@xulian.test","password":"newpass5678"}')
echo "    10 次失败后，用**正确密码**登录 → HTTP $LOCKED"
echo "    响应体: $(cat .tmp-e2e/lock.json)"
check "正确密码也被锁定（429 E_ACCOUNT_LOCKED）" '429' "$LOCKED"
check "锁定提示含 E_ACCOUNT_LOCKED" 'E_ACCOUNT_LOCKED' "$(cat .tmp-e2e/lock.json)"

echo
echo "===== 场景 7：邮箱重复注册 → E_EMAIL_TAKEN ====="
DUP=$(curl -s -o .tmp-e2e/dup.json -w '%{http_code}' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"BOB@xulian.test","password":"test1234"}')
echo "    用大小写不同的同一邮箱注册 → HTTP $DUP"
echo "    响应体: $(cat .tmp-e2e/dup.json)"
check "大小写不同也判重 → 409 E_EMAIL_TAKEN" 'E_EMAIL_TAKEN' "$(cat .tmp-e2e/dup.json)"

echo
echo "===== 场景 8：弱密码 → E_PASSWORD_WEAK ====="
WEAK=$(curl -s -o .tmp-e2e/weak.json -w '%{http_code}' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"weak@xulian.test","password":"1234"}')
echo "    响应体: $(cat .tmp-e2e/weak.json)"
check "弱密码被拒" 'E_PASSWORD_WEAK' "$(cat .tmp-e2e/weak.json)"

echo
echo "===== 场景 9：未成年保护（出生日期 < 18 岁 → isMinor=true）====="
MINOR=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"minor@xulian.test","password":"test1234","displayName":"未成年测试","birthDate":"2012-05-20"}')
check "未成年账号 isMinor=true" '"isMinor":true' "$MINOR"

echo
echo "===== 场景 10：登出 ====="
LOGOUT=$(curl -s -X POST $BASE/auth/logout -H "Authorization: Bearer $TOKEN_A")
check "登出成功" '"success":true' "$LOGOUT"
AFTER_LOGOUT=$(curl -s -o /dev/null -w '%{http_code}' $BASE/auth/me -H "Authorization: Bearer $TOKEN_A")
check "登出后同一 token → 401" '401' "$AFTER_LOGOUT"

echo
echo "======================================"
echo "结果：$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
