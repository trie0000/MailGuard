#Requires -Version 5.1

# ============================================================================
# MailGuard relay (PowerShell 版)
# ============================================================================
#
# 役割:
#   ブラウザの MailGuard (= mailguard.html) から /v1/chat/completions を受け取り、
#   ヘッダで指定された上流 AI API に転送する loopback プロキシ。
#   ブラウザは CORS の制約で外部 AI API を直接呼べないため、loopback で受けて
#   CORS ヘッダを付けて返す必要がある。
#
# 設定方針:
#   - API キー / 上流 URL / プロバイダ → ブラウザ UI (= Settings) で設定
#     リクエスト時に Authorization / X-MG-Upstream-Base / X-MG-Provider で受信
#   - relay 自体の起動設定 (= ポート) は .env で
#   - 旧 env (MG_API_KEY / MG_UPSTREAM_BASE / MG_PROVIDER) は fallback として読む
#
# 起動:
#   Windows: start-relay.bat ダブルクリック
#   直接:    powershell -NoProfile -ExecutionPolicy Bypass -File relay\mailguard-relay.ps1
#
# 必要環境:
#   PowerShell 5.1 以上 (= Windows 10/11 に標準で入っている)
#   Node.js は 不要
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# 出力を UTF-8 に
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# TLS 1.2 を有効化 (= PS 5.1 デフォルトでは 1.0 まで)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ── プロキシ設定 (= 社内環境対応) ──────────────────────────────────────
#  PowerShell の HttpWebRequest はデフォルトでシステム プロキシ
#  (= IE / Edge の設定) を参照するが、認証 (Negotiate / NTLM) が要る場合に
#  Credentials を渡さないと 407 や TimeoutException になる。
#  ここで一括設定し、以降の全 WebRequest に効かせる。
#
#  明示指定:
#    .env に MG_HTTPS_PROXY=http://proxy.example.com:8080 を書けば最優先で使う
#    (= 標準の HTTPS_PROXY env も互換でサポート)
function Initialize-WebProxy {
    param([string]$ExplicitProxy)
    if ($ExplicitProxy) {
        try {
            $proxy = New-Object System.Net.WebProxy($ExplicitProxy, $true)
            $proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
            [System.Net.WebRequest]::DefaultWebProxy = $proxy
            Write-Host "[relay] using explicit proxy: $ExplicitProxy"
            return
        } catch {
            Write-Host "[!] proxy 設定失敗: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    # システム プロキシに既定資格情報を付与
    try {
        $sysProxy = [System.Net.WebRequest]::DefaultWebProxy
        if ($sysProxy) {
            $sysProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
            # 検出されたシステム プロキシを表示 (= デバッグ用)
            try {
                $testUri = [Uri]'https://api.anthropic.com'
                $resolved = $sysProxy.GetProxy($testUri)
                if ($resolved -and $resolved.AbsoluteUri -ne $testUri.AbsoluteUri) {
                    Write-Host "[relay] system proxy detected: $($resolved.AbsoluteUri)"
                } else {
                    Write-Host "[relay] system proxy: direct (= プロキシなし)"
                }
            } catch { }
        }
    } catch { }
}
# 呼び出しは .env 読み込み & 設定値解決の後 (= $proxyUrl が決まってから)

# ── .env ローダ ────────────────────────────────────────────────────────
function Import-DotEnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 0) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) {
            [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        }
    }
    Write-Host "[relay] loaded env from: $Path"
}

# 探索: カレント / リポジトリ ルート / スクリプト隣
$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$envCandidates = @(
    (Join-Path (Get-Location).Path '.env'),
    (Join-Path $repoRoot '.env'),
    (Join-Path $scriptDir '.env')
) | Select-Object -Unique
foreach ($p in $envCandidates) {
    if (Test-Path -LiteralPath $p) { Import-DotEnvFile -Path $p; break }
}

# ── 設定値 (= .env で上書き可、Spira 互換の変数名) ───────────────────────
#   優先順位: MAILGUARD_AI_* (= 推奨) → MG_* (= 旧、後方互換) → 既定値
function Get-EnvAny {
    param([string[]]$Names, [string]$Default = '')
    foreach ($n in $Names) {
        $v = [Environment]::GetEnvironmentVariable($n, 'Process')
        if ($v) { return $v }
    }
    return $Default
}

$port = 18100
$portStr = Get-EnvAny @('MAILGUARD_AI_PORT', 'MG_PORT')
if ($portStr) {
    try { $port = [int]$portStr } catch { Write-Host "[!] 不正なポート値: $portStr (= 18100 を使用)" }
}
$fallbackApiKey   = Get-EnvAny @('MAILGUARD_AI_KEY', 'MG_API_KEY')
$fallbackUpstream = (Get-EnvAny @('MAILGUARD_AI_TARGET', 'MG_UPSTREAM_BASE')).TrimEnd('/')
$fallbackProvider = (Get-EnvAny @('MAILGUARD_AI_PROVIDER', 'MG_PROVIDER')).ToLower()
$proxyUrl         = Get-EnvAny @('MAILGUARD_AI_PROXY', 'MG_HTTPS_PROXY', 'HTTPS_PROXY')
$skipCertCheck    = (Get-EnvAny @('MAILGUARD_AI_SKIP_CERT_CHECK')) -eq '1'

if ($skipCertCheck) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { return $true }
    Write-Host "[!] 警告: TLS 証明書検証を無効化しています (MAILGUARD_AI_SKIP_CERT_CHECK=1)" -ForegroundColor Yellow
}

# プロキシ初期化 ($proxyUrl が決まったタイミングで)
Initialize-WebProxy -ExplicitProxy $proxyUrl

# ── CORS / レスポンス ──────────────────────────────────────────────────
function Set-CorsHeaders {
    param([System.Net.HttpListenerResponse]$Response)
    $Response.Headers.Add('Access-Control-Allow-Origin', '*')
    $Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $Response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-MG-Provider, X-MG-Upstream-Base, X-MG-Deployment, X-MG-Api-Version, x-api-key, anthropic-version, api-key')
    $Response.Headers.Add('Access-Control-Max-Age', '86400')
}

function Send-Json {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [string]$Body
    )
    Set-CorsHeaders -Response $Response
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json; charset=utf-8'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.Close()
}

function Read-RequestBody {
    param([System.Net.HttpListenerRequest]$Request)
    if (-not $Request.HasEntityBody) { return '' }
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    $reader.Close()
    return $body
}

# ── リクエスト ごとの上流 設定 ──────────────────────────────────────────
function Resolve-Context {
    param([System.Net.HttpListenerRequest]$Request)

    $provider = $Request.Headers['X-MG-Provider']
    if (-not $provider) { $provider = $fallbackProvider }
    if (-not $provider) { $provider = 'claude' }
    $provider = $provider.ToLower()
    # Spira 互換: 'anthropic' は 'claude' のエイリアス
    if ($provider -eq 'anthropic') { $provider = 'claude' }
    # 'openai' は 'corp' のエイリアス (= passthrough する従来モード)
    if ($provider -eq 'openai') { $provider = 'corp' }

    $upstream = $Request.Headers['X-MG-Upstream-Base']
    if (-not $upstream) { $upstream = $fallbackUpstream }
    if (-not $upstream) {
        $upstream = if ($provider -eq 'claude') { 'https://api.anthropic.com' } else { 'https://api.openai.com' }
    }
    $upstream = $upstream.TrimEnd('/')

    $deployment = $Request.Headers['X-MG-Deployment']
    $apiVersion = $Request.Headers['X-MG-Api-Version']

    $auth = $Request.Headers['Authorization']
    $apiKey = ''
    if ($auth) {
        if ($auth.StartsWith('Bearer ', [System.StringComparison]::OrdinalIgnoreCase)) {
            $apiKey = $auth.Substring(7).Trim()
        } else {
            $apiKey = $auth.Trim()
        }
    }
    if (-not $apiKey) { $apiKey = $fallbackApiKey }

    return [PSCustomObject]@{
        Provider   = $provider
        Upstream   = $upstream
        ApiKey     = $apiKey
        Deployment = $deployment
        ApiVersion = $apiVersion
    }
}

function Build-UpstreamHeaders {
    param([PSCustomObject]$Context)
    $h = @{
        'Content-Type' = 'application/json'
        'Accept'       = 'application/json'
    }
    if (-not $Context.ApiKey) { return $h }
    if ($Context.Provider -eq 'claude') {
        $h['x-api-key'] = $Context.ApiKey
        $h['anthropic-version'] = '2023-06-01'
    } elseif ($Context.Provider -eq 'corp' -and $Context.Deployment) {
        # Azure OpenAI スタイル: api-key ヘッダ (= Bearer ではない)
        $h['api-key'] = $Context.ApiKey
    } else {
        # OpenAI 直接 (= passthrough)
        $h['Authorization'] = "Bearer $($Context.ApiKey)"
    }
    return $h
}

# ── 上流 HTTP リクエスト ──────────────────────────────────────────────
function Invoke-Upstream {
    param(
        [string]$Url,
        [string]$Method,
        [hashtable]$Headers,
        [string]$Body
    )

    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = $Method
    # AI 推論は長い (= reasoning モデルだと 60s+) ので timeout を 3 分に
    $req.Timeout = 180000
    $req.ReadWriteTimeout = 180000

    foreach ($k in $Headers.Keys) {
        $v = $Headers[$k]
        switch -Wildcard ($k) {
            'Content-Type' { $req.ContentType = $v }
            'Accept'       { $req.Accept = $v }
            'User-Agent'   { $req.UserAgent = $v }
            default        { $req.Headers.Add($k, $v) }
        }
    }

    if ($Body -and ($Method -eq 'POST' -or $Method -eq 'PUT')) {
        if (-not $req.ContentType) { $req.ContentType = 'application/json' }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }

    $statusCode = 0
    $respBody = ''
    try {
        $resp = $req.GetResponse()
        $statusCode = [int]$resp.StatusCode
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $respBody = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            # HTTP エラー応答が来た場合 (= 4xx/5xx) は upstream の本文を透過
            $statusCode = [int]$_.Exception.Response.StatusCode
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
            $respBody = $reader.ReadToEnd()
            $reader.Close()
            $_.Exception.Response.Close()
        } else {
            # 通信エラー (タイムアウト / DNS / 接続拒否 等) は status で分類して案内
            $status = $_.Exception.Status
            $hint = ''
            if ($status -eq [System.Net.WebExceptionStatus]::Timeout) {
                $hint = 'タイムアウト (180s)。 ' +
                    '社内プロキシ環境の場合は .env に MG_HTTPS_PROXY=http://proxy:port を設定。 ' +
                    'または IE のプロキシ設定が正しいか確認してください。'
            } elseif ($status -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) {
                $hint = 'DNS 解決失敗。 上流 URL のホスト名が正しいか確認してください。'
            } elseif ($status -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
                $hint = '接続失敗。 上流ホストにアクセスできません (ファイアウォール / プロキシ)。'
            } elseif ($status -eq [System.Net.WebExceptionStatus]::TrustFailure) {
                $hint = 'TLS / 証明書 エラー。 社内プロキシで MITM 証明書が必要かもしれません。'
            } else {
                $hint = "通信エラー (status=$status)。 .env に MG_HTTPS_PROXY を設定すれば社内プロキシ経由になります。"
            }
            $detail = ($_.Exception.Message -replace '"', "'") + ' / ' + $hint
            Write-Host "[relay] upstream error: $detail" -ForegroundColor Yellow
            return [PSCustomObject]@{ StatusCode = 502; Body = '{"error":{"message":"' + $detail + '","upstream":"' + ($Url -replace '"', "'") + '"}}' }
        }
    } catch {
        Write-Host "[relay] unexpected error: $($_.Exception.Message)" -ForegroundColor Yellow
        return [PSCustomObject]@{ StatusCode = 502; Body = '{"error":{"message":"upstream error: ' + ($_.Exception.Message -replace '"', "'") + '"}}' }
    }

    return [PSCustomObject]@{ StatusCode = $statusCode; Body = $respBody }
}

# ── OpenAI ↔ Anthropic 翻訳 ──────────────────────────────────────────
function ConvertTo-AnthropicRequest {
    param($OpenAIReq)

    $messages = @()
    $system = ''
    if ($OpenAIReq.messages) {
        foreach ($m in $OpenAIReq.messages) {
            if ($m.role -eq 'system') {
                $content = if ($null -ne $m.content) { [string]$m.content } else { '' }
                $system = if ($system) { "$system`n`n$content" } else { $content }
            } elseif ($m.role -eq 'user' -or $m.role -eq 'assistant') {
                $messages += @{ role = $m.role; content = if ($null -ne $m.content) { [string]$m.content } else { '' } }
            }
        }
    }

    $model = if ($OpenAIReq.model) { $OpenAIReq.model } else { 'claude-sonnet-4-5' }
    $maxTokens = if ($OpenAIReq.max_tokens) { [int]$OpenAIReq.max_tokens } else { 4096 }

    $out = [ordered]@{
        model      = $model
        max_tokens = $maxTokens
        messages   = $messages
    }
    if ($system) { $out['system'] = $system }
    if ($null -ne $OpenAIReq.temperature) { $out['temperature'] = $OpenAIReq.temperature }
    return $out
}

function ConvertFrom-AnthropicResponse {
    param($AnthropicResp)

    $content = ''
    if ($AnthropicResp.content) {
        foreach ($block in $AnthropicResp.content) {
            if ($block.type -eq 'text' -and $block.text) {
                $content += $block.text
            }
        }
    }

    $finishReason = switch ($AnthropicResp.stop_reason) {
        'end_turn'      { 'stop' }
        'stop_sequence' { 'stop' }
        'max_tokens'    { 'length' }
        default         { if ($AnthropicResp.stop_reason) { $AnthropicResp.stop_reason } else { 'stop' } }
    }

    $promptTokens = if ($AnthropicResp.usage -and $AnthropicResp.usage.input_tokens) { [int]$AnthropicResp.usage.input_tokens } else { 0 }
    $completionTokens = if ($AnthropicResp.usage -and $AnthropicResp.usage.output_tokens) { [int]$AnthropicResp.usage.output_tokens } else { 0 }

    $epoch = [int][double]::Floor((Get-Date -UFormat %s))
    $id = if ($AnthropicResp.id) { $AnthropicResp.id } else { "cmpl-$epoch" }
    $model = if ($AnthropicResp.model) { $AnthropicResp.model } else { '' }

    return [ordered]@{
        id      = $id
        object  = 'chat.completion'
        created = $epoch
        model   = $model
        choices = @(
            [ordered]@{
                index         = 0
                message       = [ordered]@{ role = 'assistant'; content = $content }
                finish_reason = $finishReason
            }
        )
        usage = [ordered]@{
            prompt_tokens     = $promptTokens
            completion_tokens = $completionTokens
            total_tokens      = ($promptTokens + $completionTokens)
        }
    }
}

# ── ハンドラ ───────────────────────────────────────────────────────────
function Handle-Chat {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response
    )

    $body = Read-RequestBody -Request $Request
    $ctx = Resolve-Context -Request $Request

    if ($ctx.Provider -eq 'claude') {
        # Anthropic Messages API への翻訳
        try {
            $openaiReq = $body | ConvertFrom-Json
        } catch {
            Send-Json -Response $Response -StatusCode 400 -Body '{"error":{"message":"invalid JSON request"}}'
            return
        }
        $anthropicReq = ConvertTo-AnthropicRequest -OpenAIReq $openaiReq
        $sendBody = $anthropicReq | ConvertTo-Json -Depth 100 -Compress
        $upstreamUrl = "$($ctx.Upstream)/v1/messages"
        Write-Host "[relay] POST /v1/chat/completions -> $upstreamUrl (claude, model=$($anthropicReq.model))"

        $headers = Build-UpstreamHeaders -Context $ctx
        $upstreamResp = Invoke-Upstream -Url $upstreamUrl -Method 'POST' -Headers $headers -Body $sendBody

        if ($upstreamResp.StatusCode -eq 200) {
            try {
                $anthropicResp = $upstreamResp.Body | ConvertFrom-Json
                $openaiResp = ConvertFrom-AnthropicResponse -AnthropicResp $anthropicResp
                $respBody = $openaiResp | ConvertTo-Json -Depth 100 -Compress
                Send-Json -Response $Response -StatusCode 200 -Body $respBody
            } catch {
                Write-Host "[relay] response translation failed: $_" -ForegroundColor Yellow
                Send-Json -Response $Response -StatusCode 502 -Body ('{"error":{"message":"response translation failed: ' + ($_.Exception.Message -replace '"', "'") + '"}}')
            }
        } else {
            $bodyPreview = if ($upstreamResp.Body) { $upstreamResp.Body.Substring(0, [Math]::Min(200, $upstreamResp.Body.Length)) } else { '' }
            Write-Host "[relay] claude HTTP $($upstreamResp.StatusCode): $bodyPreview" -ForegroundColor Yellow
            Send-Json -Response $Response -StatusCode $upstreamResp.StatusCode -Body $upstreamResp.Body
        }
    }
    elseif ($ctx.Provider -eq 'corp' -and $ctx.Deployment) {
        # Azure OpenAI 互換: {base}/openai/deployments/{deployment}/chat/completions?api-version=...
        $apiVer = if ($ctx.ApiVersion) { $ctx.ApiVersion } else { '2024-06-01' }
        $upstreamUrl = "$($ctx.Upstream)/openai/deployments/$($ctx.Deployment)/chat/completions?api-version=$apiVer"
        Write-Host "[relay] POST /v1/chat/completions -> $upstreamUrl (corp/azure, $($body.Length) bytes)"
        $headers = Build-UpstreamHeaders -Context $ctx
        $upstreamResp = Invoke-Upstream -Url $upstreamUrl -Method 'POST' -Headers $headers -Body $body
        Send-Json -Response $Response -StatusCode $upstreamResp.StatusCode -Body $upstreamResp.Body
    }
    else {
        # OpenAI 互換 (= passthrough、X-MG-Deployment 無し時のフォールバック)
        $upstreamUrl = "$($ctx.Upstream)/v1/chat/completions"
        Write-Host "[relay] POST /v1/chat/completions -> $upstreamUrl (openai-passthrough, $($body.Length) bytes)"
        $headers = Build-UpstreamHeaders -Context $ctx
        $upstreamResp = Invoke-Upstream -Url $upstreamUrl -Method 'POST' -Headers $headers -Body $body
        Send-Json -Response $Response -StatusCode $upstreamResp.StatusCode -Body $upstreamResp.Body
    }
}

function Handle-Models {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response
    )

    $ctx = Resolve-Context -Request $Request
    $upstreamUrl = "$($ctx.Upstream)/v1/models"
    Write-Host "[relay] GET /v1/models -> $upstreamUrl ($($ctx.Provider))"
    $headers = Build-UpstreamHeaders -Context $ctx
    $upstreamResp = Invoke-Upstream -Url $upstreamUrl -Method 'GET' -Headers $headers -Body ''
    Send-Json -Response $Response -StatusCode $upstreamResp.StatusCode -Body $upstreamResp.Body
}

function Handle-Request {
    param([System.Net.HttpListenerContext]$Context)

    $req = $Context.Request
    $res = $Context.Response

    # CORS プリフライト
    if ($req.HttpMethod -eq 'OPTIONS') {
        Set-CorsHeaders -Response $res
        $res.StatusCode = 204
        $res.Close()
        return
    }

    $pathLower = $req.Url.AbsolutePath.ToLower()

    if ($pathLower -eq '/health' -or $pathLower -eq '/spira/health') {
        $info = [ordered]@{
            ok                 = $true
            relay              = 'mailguard-ps-relay'
            port               = $port
            note               = 'API key / upstream / provider は ブラウザ UI から送信される X-MG-* / Authorization ヘッダで受信'
            fallbackProvider   = if ($fallbackProvider) { $fallbackProvider } else { $null }
            fallbackUpstream   = if ($fallbackUpstream) { $fallbackUpstream } else { $null }
            hasFallbackApiKey  = [bool]$fallbackApiKey
        }
        Send-Json -Response $res -StatusCode 200 -Body ($info | ConvertTo-Json -Depth 10 -Compress)
        return
    }

    # /defaults: env で設定された組織共通デフォルトを返す (= API キーは含めない)
    #   ブラウザは初回起動時にこれをフェッチして localStorage に seed する。
    if ($pathLower -eq '/defaults' -and $req.HttpMethod -eq 'GET') {
        $domains = (Get-EnvAny @('MAILGUARD_OWN_DOMAINS', 'MAILGUARD_AI_OWN_DOMAINS')).Split(',') `
            | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $keywords = (Get-EnvAny @('MAILGUARD_INTERNAL_KEYWORDS', 'MAILGUARD_AI_INTERNAL_KEYWORDS')).Split(',') `
            | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $defaults = [ordered]@{
            provider          = if ($fallbackProvider) { $fallbackProvider } else { '' }
            corpBaseUrl       = if ($fallbackUpstream) { $fallbackUpstream } else { '' }
            corpDeployPrefix  = Get-EnvAny @('MAILGUARD_AI_DEPLOY_PREFIX')
            corpModel         = Get-EnvAny @('MAILGUARD_AI_CORP_MODEL')
            claudeModel       = Get-EnvAny @('MAILGUARD_AI_CLAUDE_MODEL')
            ownDomains        = @($domains)
            internalKeywords  = @($keywords)
        }
        Send-Json -Response $res -StatusCode 200 -Body ($defaults | ConvertTo-Json -Depth 10 -Compress)
        return
    }

    if ($pathLower -eq '/v1/chat/completions' -and $req.HttpMethod -eq 'POST') {
        Handle-Chat -Request $req -Response $res
        return
    }

    if ($pathLower -eq '/v1/models' -and $req.HttpMethod -eq 'GET') {
        Handle-Models -Request $req -Response $res
        return
    }

    Send-Json -Response $res -StatusCode 404 -Body ('{"error":{"message":"Not Found: ' + $req.Url.AbsolutePath + '"}}')
}

# ── HttpListener 起動 ───────────────────────────────────────────────────
$prefix = "http://127.0.0.1:$port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host ''
    Write-Host "[!] HttpListener.Start() に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
    # ポート競合の検知 (= 二重起動が一番ありがち)
    $portInUse = $false
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            $portInUse = $true
            Write-Host '' -ForegroundColor Yellow
            Write-Host "[!] ポート $port は既に別プロセスが使用中:" -ForegroundColor Yellow
            foreach ($c in $conn) {
                $procName = '?'
                try { $procName = (Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName } catch { }
                Write-Host "       PID=$($c.OwningProcess) ($procName)" -ForegroundColor Yellow
            }
            Write-Host ''
            Write-Host "    対処 (どちらか):" -ForegroundColor Yellow
            Write-Host "      A. 既存の relay (= 別ウィンドウで起動中) を Ctrl+C で停止 → このスクリプトを再起動"
            Write-Host "      B. 強制終了: Stop-Process -Id $($conn[0].OwningProcess) -Force"
            Write-Host "      C. このインスタンスは別ポートで起動: .env に MAILGUARD_AI_PORT=18200 等を設定"
        }
    } catch { }
    if (-not $portInUse) {
        Write-Host '' -ForegroundColor Yellow
        Write-Host '    対処:' -ForegroundColor Yellow
        Write-Host '      - ポート権限: HttpListener が 127.0.0.1 のバインドを拒否される稀なケース'
        Write-Host '      - .env で MAILGUARD_AI_PORT=18200 等に変更してみる'
    }
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  📨 MailGuard relay (PowerShell)'
Write-Host '  -----------------------------------------'
Write-Host "  Listen  : $prefix"
Write-Host '  設定方針 : API キー / 上流 URL / プロバイダ は ブラウザ UI から送信'
Write-Host "  Test    : curl $($prefix)health"
if ($fallbackApiKey -or $fallbackUpstream -or $fallbackProvider) {
    Write-Host '  -----------------------------------------'
    Write-Host '  env fallback (= UI 未設定時に使用):'
    if ($fallbackProvider) { Write-Host "    MG_PROVIDER      = $fallbackProvider" }
    if ($fallbackUpstream) { Write-Host "    MG_UPSTREAM_BASE = $fallbackUpstream" }
    if ($fallbackApiKey)   {
        $masked = $fallbackApiKey.Substring(0, [Math]::Min(8, $fallbackApiKey.Length))
        Write-Host "    MG_API_KEY       = $masked..."
    }
}
Write-Host '  -----------------------------------------'
Write-Host '  Ctrl+C で停止'
Write-Host ''

try {
    while ($listener.IsListening) {
        try {
            $ctx = $listener.GetContext()
            Handle-Request -Context $ctx
        } catch [System.Net.HttpListenerException] {
            # 停止時の正常終了
            if ($_.Exception.ErrorCode -eq 995 -or -not $listener.IsListening) { break }
            Write-Host "[relay] listener error: $($_.Exception.Message)" -ForegroundColor Yellow
        } catch {
            Write-Host "[relay] error: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
} finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
    Write-Host ''
    Write-Host '[relay] stopped.'
}
