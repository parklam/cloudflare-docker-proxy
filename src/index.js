addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";
const HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="shortcut icon" href="https://res.cloudinary.com/unipark/image/upload/w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35/v1679301272/unipark/uwj3fcr7clkg9kgsrcbq.png">
    <title>Docker 镜像代理使用说明</title>
    <style>
        body {
            font-family: 'Roboto', sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
        }
        .header {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: #fff;
            padding: 20px 0;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .container {
            max-width: 800px;
            margin: 40px auto;
            padding: 20px;
            background-color: #fff;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            border-radius: 10px;
        }
        .content {
            margin-bottom: 20px;
        }
        .footer {
            text-align: center;
            padding: 20px 0;
            background-color: #333;
            color: #fff;
        }
        pre {
            background-color: #272822;
            color: #f8f8f2;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
        }
        code {
            font-family: 'Source Code Pro', monospace;
        }
        a {
            font-weight: bold;
            color: #ffffff;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        @media (max-width: 600px) {
            .container {
                margin: 20px;
                padding: 15px;
            }
            .header {
                padding: 15px 0;
            }
        }
    </style>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Source+Code+Pro:wght@400;700&display=swap" rel="stylesheet">
</head>
<body>
    <div class="header">
        <h1>Docker 镜像代理使用说明</h1>
    </div>
    <div class="container">
        <div class="content">
          <h3>带镜像仓库地址使用说明</h3>
          <p>1.拉取镜像</p>
          <pre><code># 拉取 redis 官方镜像（不带命名空间）
docker pull {:host}/redis

# 拉取 rabbitmq 官方镜像
docker pull {:host}/library/rabbitmq

# 拉取 postgresql 非官方镜像
docker pull {:host}/bitnami/postgresql</code></pre><p>2.重命名镜像</p>
          <pre><code># 重命名 redis 镜像
docker tag {:host}/library/redis redis 

# 重命名 postgresql 镜像
docker tag {:host}/bitnami/postgresql bitnami/postgresql</code></pre><h3>镜像源方式使用说明</h3><p>1.添加镜像源</p>
          <pre><code># 添加镜像代理到 Docker 镜像源
sudo tee /etc/docker/daemon.json &lt;&lt; EOF
{
  "registry-mirrors": ["https://{:host}"]
}
EOF</code></pre><p>2.拉取镜像</p>
<pre><code># 拉取 redis 官方镜像
docker pull redis

# 拉取 rabbitmq 非官方镜像
docker pull bitnami/rabbitmq

# 拉取 postgresql 官方镜像
docker pull postgresql</code></pre>
        </div>
    </div>
    <div class="footer">
        <p>©2024 <a href="https://www.unipark.io">unipark.io</a>. All rights reserved. Powered by <a href="https://cloudflare.com">Cloudflare</a>.</p>
    </div>
</body>
</html>
`

const routes = {
  "docker.unipark.io": dockerHub,
  "quay.unipark.io": "https://quay.io",
  "gcr.unipark.io": "https://gcr.io",
  "k8s-gcr.unipark.io": "https://k8s.gcr.io",
  "k8s.unipark.io": "https://registry.k8s.io",
  "ghcr.unipark.io": "https://ghcr.io",
  "cloudsmith.unipark.io": "https://docker.cloudsmith.io",
  "ecr.unipark.io": "https://public.ecr.aws",
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname == "/") {
    return handleHomeRequest(url.host);
  }

  const upstream = routeByHosts(url.hostname);
  if (!upstream) {
    return createNotFoundResponse(routes);
  }

  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    return handleFirstRequest(upstream, authorization, url.hostname);
  }
  // get token
  if (url.pathname == "/v2/auth") {
    return handleAuthRequest(upstream, url, isDockerHub, authorization);
  }
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl.toString(), 301);
    }
  }
  return handlePullRequest(upstream, request);
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function handleHomeRequest(host) {
  return new Response(HTML.replace(/{:host}/g, host), {
    status: 200,
    headers: {
      "content-type": "text/html",
    }
  })
}

async function handlePullRequest(upstream, request) {
  const url = new URL(request.url);
  const newUrl = new URL(upstream + url.pathname);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    redirect: "follow",
  });
  return await fetch(newReq);
}

async function handleFirstRequest(upstream, authorization, hostname) {
  const newUrl = new URL(upstream + "/v2/");
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  // check if need to authenticate
  const resp = await fetch(newUrl.toString(), {
    method: "GET",
    headers: headers,
    redirect: "follow",
  });
  if (resp.status === 401) {
      headers.set(
        "Www-Authenticate",
        `Bearer realm="https://${hostname}/v2/auth",service="cloudflare-docker-proxy"`
      );
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: headers,
    });
  } else {
    return resp;
  }
}

async function handleAuthRequest(upstream, url, isDockerHub, authorization) {
  const newUrl = new URL(upstream + "/v2/");
  const resp = await fetch(newUrl.toString(), {
    method: "GET",
    redirect: "follow",
  });
  if (resp.status !== 401) {
    return resp;
  }
  const authenticateStr = resp.headers.get("WWW-Authenticate");
  if (authenticateStr === null) {
    return resp;
  }
  const wwwAuthenticate = parseAuthenticate(authenticateStr);
  let scope = url.searchParams.get("scope");
  // autocomplete repo part into scope for DockerHub library images
  // Example: repository:busybox:pull => repository:library/busybox:pull
  if (scope && isDockerHub) {
    let scopeParts = scope.split(":");
    if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
      scopeParts[1] = "library/" + scopeParts[1];
      scope = scopeParts.join(":");
    }
  }
  return await fetchToken(wwwAuthenticate, scope, authorization);
}

const createNotFoundResponse = (routes) => new Response(
  JSON.stringify({ routes }),
  {
    status: 404,
    headers: {
      "Content-Type": "application/json",
    },
  }
);
