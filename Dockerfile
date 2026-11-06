FROM node:20-alpine
WORKDIR /app
# server.js 使用 ESM 语法，必须带上 package.json 的 "type": "module"
COPY package.json ./
COPY server.js .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# 非 root 运行
USER node
CMD ["node", "server.js"]
