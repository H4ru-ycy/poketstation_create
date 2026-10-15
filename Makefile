# PocketStation ドット絵アニメ - ビルド
#
#   make                       … サンプルアニメ入りで build/ に出力
#   make FRAMES=my.pda         … 変換ツールで書き出した .pda を使う
#   make MUSIC=song.pmu        … 変換ツールで書き出した曲 (.pmu) を入れる
#   make NOMUSIC=1             … 曲なし (省略時はサンプル曲「きらきら星」)
#   make CHARA=project.json    … キャラクターモードで作る (変換ツールの作品ファイルの設定を使う)
#   make TOOLCHAIN=gcc         … arm-none-eabi-gcc を使う (既定は clang)
#
# 出力: build/anime.mcr (メモリーカードイメージ, エミュレータ/書き込み用)
#       build/anime.mcs (単体セーブ)   build/anime.bin (生ファイル, SC形式)

TOOLCHAIN ?= clang
TITLE     ?= ドット絵アニメ
FILENAME  ?= BISLPSP00000ANIME
FRAMES    ?=
MUSIC     ?=
DELAY     ?=
CHARA     ?=

ifeq ($(TOOLCHAIN),gcc)
CC      = arm-none-eabi-gcc
LD      = arm-none-eabi-gcc
OBJCOPY = arm-none-eabi-objcopy
ARCH    = -mcpu=arm7tdmi -marm
LDFLAGS = $(ARCH) -nostdlib -nostartfiles -Wl,--gc-sections -T src/poc.ld
else
CC      = clang
LD      = ld.lld
OBJCOPY = llvm-objcopy
ARCH    = --target=armv4t-none-eabi -mcpu=arm7tdmi -marm
LDFLAGS = --gc-sections -T src/poc.ld
endif

CFLAGS  = $(ARCH) -Os -ffreestanding -fno-builtin -nostdlib \
          -ffunction-sections -fdata-sections -Wall -Wextra

OBJS = build/crt0.o build/main.o build/chara.o build/sound.o build/sound_fiq.o

ARGS = --title "$(TITLE)" --filename "$(FILENAME)"
ifneq ($(FRAMES),)
ARGS += --frames $(FRAMES)
endif
ifneq ($(MUSIC),)
ARGS += --music $(MUSIC)
else ifeq ($(NOMUSIC),)
ARGS += --sample-music
endif
ifneq ($(DELAY),)
ARGS += --delay $(DELAY)
endif
ifneq ($(CHARA),)
ARGS += --chara $(CHARA)
endif

all: build/anime.mcr

build:
	mkdir -p build

build/sound_fiq.o: src/sound.S | build
	$(CC) $(ARCH) -c $< -o $@

build/%.o: src/%.c src/poc.h src/sound.h src/app.h src/font.h | build
	$(CC) $(CFLAGS) -c $< -o $@

build/%.o: src/%.S | build
	$(CC) $(ARCH) -c $< -o $@

build/player.elf: $(OBJS) src/poc.ld
	$(LD) $(LDFLAGS) $(OBJS) -o $@

build/player.bin: build/player.elf
	$(OBJCOPY) -O binary $< $@

build/anime.mcr: build/player.bin tools/mkpoc.py tools/pmus.py $(FRAMES) $(MUSIC) $(CHARA)
	python3 tools/mkpoc.py build/player.bin -o build/anime $(ARGS)

# フォント (src/font.h と converter/font.js) を作り直す
font:
	python3 tools/genfont.py

test: build/anime.mcr
	python3 tests/test_player.py build/anime.bin 0
	python3 tests/test_chara.py build/player.bin 0
	node tests/test_card.js build/anime.mcr build/anime.bin BISLPSP00000TEST2

clean:
	rm -rf build

.PHONY: all clean font test

# スマホ用の変換ツール (再生プログラム埋め込み済みの単体HTML)
converter: build/dot-studio.html
build/dot-studio.html: converter/converter.src.html converter/omr.js converter/font.js converter/chara.js converter/card.js build/player.bin tools/embed_player.py
	python3 tools/embed_player.py $< build/player.bin $@

.PHONY: converter
