# PocketStation ドット絵アニメ - ビルド
#
#   make                       … サンプルアニメ入りで build/ に出力
#   make FRAMES=my.pda         … 変換ツールで書き出した .pda を使う
#   make MUSIC=song.pmu        … 変換ツールで書き出した曲 (.pmu) を入れる
#   make NOMUSIC=1             … 曲なし (省略時はサンプル曲「きらきら星」)
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

OBJS = build/crt0.o build/main.o build/sound.o build/sound_fiq.o

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

all: build/anime.mcr

build:
	mkdir -p build

build/sound_fiq.o: src/sound.S | build
	$(CC) $(ARCH) -c $< -o $@

build/%.o: src/%.c src/poc.h src/sound.h | build
	$(CC) $(CFLAGS) -c $< -o $@

build/%.o: src/%.S | build
	$(CC) $(ARCH) -c $< -o $@

build/player.elf: $(OBJS) src/poc.ld
	$(LD) $(LDFLAGS) $(OBJS) -o $@

build/player.bin: build/player.elf
	$(OBJCOPY) -O binary $< $@

build/anime.mcr: build/player.bin tools/mkpoc.py tools/pmus.py $(FRAMES) $(MUSIC)
	python3 tools/mkpoc.py build/player.bin -o build/anime $(ARGS)

clean:
	rm -rf build

.PHONY: all clean

# スマホ用の変換ツール (再生プログラム埋め込み済みの単体HTML)
converter: build/dot-studio.html
build/dot-studio.html: converter/converter.src.html converter/omr.js build/player.bin tools/embed_player.py
	python3 tools/embed_player.py $< build/player.bin $@

.PHONY: converter
