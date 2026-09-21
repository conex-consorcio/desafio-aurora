FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 4010
CMD ["npx", "tsx", "server.ts"]
