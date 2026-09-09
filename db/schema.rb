# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_09_120000) do
  create_table "game_answers", force: :cascade do |t|
    t.boolean "correct"
    t.string "game_id", null: false
    t.integer "idx", null: false
    t.integer "ms"
    t.string "player", null: false
    t.integer "points", default: 0, null: false
    t.json "response"
    t.index ["game_id", "idx", "player"], name: "index_game_answers_on_game_id_and_idx_and_player", unique: true
    t.index ["game_id"], name: "index_game_answers_on_game_id"
  end

  create_table "game_players", force: :cascade do |t|
    t.string "game_id", null: false
    t.string "identifier"
    t.string "name", null: false
    t.integer "rank"
    t.integer "score", default: 0, null: false
    t.index ["game_id", "name"], name: "index_game_players_on_game_id_and_name", unique: true
    t.index ["game_id"], name: "index_game_players_on_game_id"
  end

  create_table "game_questions", force: :cascade do |t|
    t.text "answer"
    t.json "choices"
    t.json "correct_answer"
    t.text "explanation"
    t.string "game_id", null: false
    t.integer "idx", null: false
    t.string "question_type", null: false
    t.integer "source_idx"
    t.text "text", null: false
    t.index ["game_id", "idx"], name: "index_game_questions_on_game_id_and_idx", unique: true
    t.index ["game_id"], name: "index_game_questions_on_game_id"
  end

  create_table "games", id: :string, force: :cascade do |t|
    t.datetime "ended_at"
    t.string "pin", null: false
    t.integer "player_count", default: 0, null: false
    t.integer "question_count", default: 0, null: false
    t.integer "quiz_id"
    t.string "quiz_slug", null: false
    t.integer "roster_id"
    t.datetime "started_at", null: false
    t.string "title", null: false
    t.integer "user_id", null: false
    t.index ["quiz_id"], name: "index_games_on_quiz_id"
    t.index ["roster_id"], name: "index_games_on_roster_id"
    t.index ["user_id", "started_at"], name: "index_games_on_user_id_and_started_at"
    t.index ["user_id"], name: "index_games_on_user_id"
  end

  create_table "quizzes", force: :cascade do |t|
    t.json "body", null: false
    t.datetime "created_at", null: false
    t.string "slug", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.integer "user_id", null: false
    t.index ["user_id", "slug"], name: "index_quizzes_on_user_id_and_slug", unique: true
    t.index ["user_id"], name: "index_quizzes_on_user_id"
  end

  create_table "rosters", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "slug", null: false
    t.json "students", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.integer "user_id", null: false
    t.index ["user_id", "slug"], name: "index_rosters_on_user_id_and_slug", unique: true
    t.index ["user_id"], name: "index_rosters_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "display_name"
    t.string "eppn", null: false
    t.string "role", default: "instructor", null: false
    t.datetime "updated_at", null: false
    t.index ["eppn"], name: "index_users_on_eppn", unique: true
  end

  add_foreign_key "game_answers", "games", on_delete: :cascade
  add_foreign_key "game_players", "games", on_delete: :cascade
  add_foreign_key "game_questions", "games", on_delete: :cascade
  add_foreign_key "games", "quizzes", on_delete: :nullify
  add_foreign_key "games", "rosters", on_delete: :nullify
  add_foreign_key "games", "users"
  add_foreign_key "quizzes", "users"
  add_foreign_key "rosters", "users"
end
