FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk \
    expect \
    wget \
    unzip \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV BUBBLEWRAP_HOME=/root/.bubblewrap
ENV PATH="/app/node_modules/.bin:${PATH}:${JAVA_HOME}/bin:${ANDROID_SDK_ROOT}/tools/bin:${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/build-tools/34.0.0"

# IMPORTANTE PARA O BUBBLEWRAP:
# O Bubblewrap valida o Android SDK procurando a pasta "tools" dentro da raiz do SDK.
# Por isso instalamos o command line tools como /opt/android-sdk/tools, e não somente
# como /opt/android-sdk/cmdline-tools/latest.
RUN mkdir -p ${ANDROID_SDK_ROOT} /root/.bubblewrap && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdtools.zip && \
    unzip -q /tmp/cmdtools.zip -d /tmp/cmdtools && \
    mv /tmp/cmdtools/cmdline-tools ${ANDROID_SDK_ROOT}/tools && \
    mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    ln -sfn ${ANDROID_SDK_ROOT}/tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm -rf /tmp/cmdtools /tmp/cmdtools.zip

RUN yes | sdkmanager --sdk_root=${ANDROID_SDK_ROOT} --licenses >/dev/null || true && \
    sdkmanager --sdk_root=${ANDROID_SDK_ROOT} \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0" \
      "extras;android;m2repository" \
      "extras;google;m2repository" || true

# Configuração prévia do Bubblewrap para NÃO perguntar JDK/SDK no runtime.
RUN printf '{\n  "jdkPath": "%s",\n  "androidSdkPath": "%s"\n}\n' "$JAVA_HOME" "$ANDROID_SDK_ROOT" > /root/.bubblewrap/config.json

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p uploads temp_build /root/.gradle && \
    printf 'org.gradle.jvmargs=-Xmx1536m\norg.gradle.daemon=false\n' > /root/.gradle/gradle.properties

EXPOSE 3000
CMD ["node", "server.js"]
