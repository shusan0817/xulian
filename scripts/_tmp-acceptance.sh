#!/usr/bin/env bash
# 临时验收脚本（验证完即删）：T02 七项验收
set -u
BASE=http://localhost:3000/api
OUT=.tmp-e2e
mkdir -p "$OUT"
PASS=0; FAIL=0
green() { printf '\033[32m✓\033[0m %s\n' "$1"; }
red()   { printf '\033[31m✗\033[0m %s\n' "$1"; }
check() { if echo "$3" | grep -q "$2"; then green "$1"; PASS=$((PASS+1));
          else red "$1"; echo "    期望包含: $2"; echo "    实际: $(echo "$3" | head -c 500)"; FAIL=$((FAIL+1)); fi; }
jqr() { echo "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1; }

echo "########## 步骤 1：匿名打开首页，能看到角色「林晚」 ##########"
ANON=$(curl -s "$BASE/users/bootstrap?userId=test-user-001")
echo "$ANON" | head -c 300; echo
check "匿名 bootstrap 返回 200 OK" '"ok":true' "$ANON"
check "首页能看到角色「林晚」" '林晚' "$ANON"
check "hasPassword=false（已 detach，回到匿名）" '"hasPassword":false' "$ANON"

echo
echo "########## 步骤 2：注册新账号（attachUserId=test-user-001）→ 自动登录 ##########"
REG=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"user@xulian.test","password":"test1234","displayName":"使用者","attachUserId":"test-user-001"}')
echo "$REG" | head -c 400; echo
TOKEN=$(jqr "$REG" token)
REG_UID=$(jqr "$REG" id)
check "注册成功（201）" '"ok":true' "$REG"
check "★ 复用了同一个 users 行（不是新建账号）" '"id":"test-user-001"' "$REG"
[ -n "$TOKEN" ] && { green "拿到 token（长度 ${#TOKEN}）"; PASS=$((PASS+1)); } || { red "没拿到 token"; FAIL=$((FAIL+1)); }

echo "  -- 用 token 重新拉首页数据 --"
AFTER=$(curl -s $BASE/users/bootstrap -H "Authorization: Bearer $TOKEN")
echo "$AFTER" | head -c 300; echo
check "★ 登录后「林晚」还在" '林晚' "$AFTER"
check "★ hasPassword=true" '"hasPassword":true' "$AFTER"

echo
echo "########## 步骤 3：登出 → 再登录 → 数据依然在 ##########"
LOGOUT_HTTP=$(curl -s -o $OUT/lo.json -w '%{http_code}' -X POST $BASE/auth/logout -H "Authorization: Bearer $TOKEN")
echo "  登出 HTTP $LOGOUT_HTTP  响应: $(cat $OUT/lo.json)"
AFTER_LOGOUT=$(curl -s -o $OUT/al.json -w '%{http_code}' $BASE/auth/me -H "Authorization: Bearer $TOKEN")
echo "  登出后用旧 token 访问 /api/auth/me -> HTTP $AFTER_LOGOUT  响应: $(cat $OUT/al.json)"
check "登出后旧 token 失效 → 401" '401' "$AFTER_LOGOUT"

LOGIN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"user@xulian.test","password":"test1234"}')
TOKEN2=$(jqr "$LOGIN" token)
check "重新登录成功" '"ok":true' "$LOGIN"
check "登录回同一个账号" '"id":"test-user-001"' "$LOGIN"
RELOAD=$(curl -s $BASE/users/bootstrap -H "Authorization: Bearer $TOKEN2")
check "★ 重新登录后「林晚」依然在" '林晚' "$RELOAD"
check "★ 重新登录后 hasPassword 仍为 true" '"hasPassword":true' "$RELOAD"

echo
echo "########## 步骤 4：未登录访问受保护资源 → 401（前端据此跳 /login）##########"
echo "  本实例 ALLOW_ANONYMOUS=1，匿名可访问；另起一个 ALLOW_ANONYMOUS=0 的实例在 3002 端口验证"
STRICT_STATUS=$(curl -s http://localhost:3002/api/auth/status)
echo "  3002 /api/auth/status -> $STRICT_STATUS"
check "严格实例 allowAnonymous=false" '"allowAnonymous":false' "$STRICT_STATUS"
STRICT_BOOT=$(curl -s -o $OUT/sb.json -w '%{http_code}' http://localhost:3002/api/users/bootstrap -H 'X-User-Id: test-user-001')
echo "  3002 匿名 bootstrap -> HTTP $STRICT_BOOT  响应: $(cat $OUT/sb.json)"
check "★ 严格模式下未登录访问受保护数据 → 401" '401' "$STRICT_BOOT"
check "错误码为 E_AUTH_REQUIRED（前端守卫据此跳 /login）" 'E_AUTH_REQUIRED' "$(cat $OUT/sb.json)"

echo
echo "########## 步骤 5：curl 伪造 X-User-Id: test-user-001（此时它已注册）##########"
FORGE=$(curl -s -o $OUT/forge.json -w '%{http_code}' $BASE/characters -H 'X-User-Id: test-user-001')
echo "  GET /api/characters -H 'X-User-Id: test-user-001' -> HTTP $FORGE"
echo "  响应: $(cat $OUT/forge.json)"
check "★ 伪造 X-User-Id 冒充已注册账号 → 401" '401' "$FORGE"
check "错误码 E_AUTH_REQUIRED" 'E_AUTH_REQUIRED' "$(cat $OUT/forge.json)"

echo
echo "########## 结果 ##########"
echo "$PASS 通过 / $FAIL 失败"
echo "TOKEN2=$TOKEN2" > $OUT/token.txt
[ "$FAIL" -eq 0 ] || exit 1
