![Alternativa PWABuilder](https://www.sprintcodes.com.br/wp-content/uploads/2026/03/alternativa-pwabuilder.jpg)

# 📱 PWA Builder & APK Generator

## 📖 Descrição
Este projeto é uma aplicação web completa que permite gerar pacotes Android (APK/AAB) a partir de Progressive Web Apps (PWAs). Com uma interface moderna e intuitiva, a ferramenta automatiza o processo de empacotamento do seu site para a plataforma Android, simplificando a publicação em lojas de aplicativos.

[Leia o artigo completo sobre esta Alternativa ao PWABuilder](https://www.sprintcodes.com.br/alternativa-pwabuilder/)

## ⚠️ Pré-requisitos
Antes de começar, certifique-se de ter os seguintes requisitos instalados:
* **Node.js**: Necessário para rodar o servidor backend.
* **Ambiente Android (via Bubblewrap)**: O projeto utiliza o `@bubblewrap/cli` para gerar os pacotes, exigindo o SDK do Android e o Java Development Kit (JDK) configurados no sistema.

## 🚀 Instalação
Para instalar as dependências do projeto, execute o comando abaixo na raiz do repositório:

```bash
npm install
```

## 🖥️ Como Executar
Após instalar as dependências e configurar o ambiente (veja abaixo), inicie o servidor executando:

```bash
node server.js
```

Em seguida, abra o seu navegador e acesse: [http://localhost:3000](http://localhost:3000)

## ⚙️ Configuração de Ambiente (Crucial)
Para que a geração do APK funcione corretamente, é **essencial** aceitar as licenças do Android SDK e configurar o caminho do Java (JDK) no seu ambiente.

Se você estiver no Windows, execute os comandos abaixo no seu terminal para aceitar as licenças e definir a variável de ambiente (estes comandos assumem que o Bubblewrap instalou as ferramentas no diretório padrão do usuário):

### Aceitar as licenças do SDK:
```cmd
%USERPROFILE%\.bubblewrap\android_sdk\tools\bin\sdkmanager.bat --sdk_root="%USERPROFILE%\.bubblewrap\android_sdk" --licenses
```

### Configurar o JAVA_HOME:
```cmd
set JAVA_HOME=%USERPROFILE%\.bubblewrap\jdk
```

## 🛠️ Tecnologias
Este projeto foi desenvolvido utilizando as seguintes tecnologias:

### Backend
* **Node.js** & **Express**
* **Socket.io** (Comunicação em tempo real)
* **Multer** (Upload de arquivos)
* **Axios** & **Cheerio**
* **@bubblewrap/cli** (Geração dos pacotes Android)

### Frontend
* **HTML5**, **CSS3** & **Vanilla JavaScript** (Interface limpa, moderna e responsiva)
